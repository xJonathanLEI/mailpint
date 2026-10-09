import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { limits, messageSchema } from "../src/contracts.ts";
import { capture, listing, runtime, sample } from "./runtime.ts";

test("messages persist across restarts and support paging, read state and deletion", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailpint-test-"));
  let mf = await runtime(directory);
  try {
    const first = await capture(mf);
    const second = await capture(mf, { ...sample, Subject: "Second" });
    const list = await listing(mf, "?start=1&limit=1");
    assert.equal(list.total, 2);
    assert.equal(list.unread, 2);
    assert.equal(list.messages[0]?.ID, first);
    const detail = await mf.dispatchFetch(
      `http://mailpint.test/api/v1/message/${first}`,
    );
    const message = messageSchema.parse(await detail.json());
    assert.equal(message.HTML, sample.HTML);
    assert.equal(message.Text, sample.Text);
    assert.equal((await listing(mf)).unread, 1);
    const unread = await mf.dispatchFetch(
      "http://mailpint.test/api/v1/messages",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ IDs: [first], Read: false }),
      },
    );
    assert.equal(await unread.text(), "ok");
    await mf.dispose();
    mf = await runtime(directory);
    const restored = await listing(mf);
    assert.equal(restored.total, 2);
    assert.equal(restored.messages[0]?.ID, second);
    assert.equal(restored.unread, 2);
    const deleted = await mf.dispatchFetch(
      "http://mailpint.test/api/v1/messages",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ IDs: [first] }),
      },
    );
    assert.equal(deleted.status, 200);
    assert.equal(
      (await mf.dispatchFetch(`http://mailpint.test/api/v1/message/${first}`))
        .status,
      404,
    );
    assert.equal((await listing(mf)).total, 1);
    await mf.dispatchFetch("http://mailpint.test/api/v1/messages", {
      method: "DELETE",
    });
    assert.equal((await listing(mf)).total, 0);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid requests do not capture or clear messages", {
  timeout: 60_000,
}, async () => {
  const mf = await runtime();
  try {
    await capture(mf);
    for (const input of [
      { ...sample, Attachments: [] },
      { ...sample, From: { Email: "invalid" } },
    ]) {
      const response = await mf.dispatchFetch(
        "http://mailpint.test/api/v1/send",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      assert.equal(response.status, 400);
    }
    for (const body of ['{"IDs":', '{"IDs":null}']) {
      const response = await mf.dispatchFetch(
        "http://mailpint.test/api/v1/messages",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      assert.equal(response.status, 400);
    }
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...sample, Text: "x".repeat(limits.requestBytes) }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 100));
        controller.enqueue(bytes.slice(100));
        controller.close();
      },
    });
    const oversized = await mf.dispatchFetch(
      "http://mailpint.test/api/v1/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      },
    );
    assert.equal(oversized.status, 413);
    assert.equal((await listing(mf)).total, 1);
  } finally {
    await mf.dispose();
  }
});

test("storage limits evict old messages and failed writes return an error", {
  timeout: 120_000,
}, async () => {
  const mf = await runtime();
  try {
    const first = await capture(mf);
    for (let index = 0; index < limits.messages; index++) {
      await capture(mf, { ...sample, Subject: `Message ${index}` });
    }
    const full = await listing(mf);
    assert.equal(full.total, limits.messages);
    assert.equal(full.messages.at(-1)?.Subject, "Message 0");
    assert.equal(
      (await mf.dispatchFetch(`http://mailpint.test/api/v1/message/${first}`))
        .status,
      404,
    );
    await mf.dispatchFetch("http://mailpint.test/api/v1/messages", {
      method: "DELETE",
    });
    const large = { ...sample, Text: "x".repeat(900_000) };
    const oldest = await capture(mf, large);
    for (let index = 0; index < 24; index++) await capture(mf, large);
    const bounded = await listing(mf);
    assert.ok(bounded.total > 0 && bounded.total < 25);
    assert.equal(
      (await mf.dispatchFetch(`http://mailpint.test/api/v1/message/${oldest}`))
        .status,
      404,
    );
    const storage = await mf.unsafeGetDurableObjectStorage(
      "mailpint-test",
      "Mailbox",
      { name: "inbox" },
    );
    await storage.exec("UPDATE messages SET received = 0");
    assert.equal((await listing(mf)).total, 0);
    await capture(mf);
    await storage.exec(
      "CREATE TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    const failed = await mf.dispatchFetch("http://mailpint.test/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sample),
    });
    assert.equal(failed.status, 500);
    assert.equal((await listing(mf)).total, 1);
  } finally {
    await mf.dispose();
  }
});
