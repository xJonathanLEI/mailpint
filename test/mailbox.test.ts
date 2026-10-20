import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { limits, messageSchema } from "../src/contracts.ts";
import { capture, inbox, listing, runtime, sample } from "./runtime.ts";

const base64 = (value: string | Uint8Array) =>
  Buffer.from(value).toString("base64");

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
    const attachment = {
      Content: base64("%PDF"),
      Filename: "agreement.pdf",
      ContentType: "application/pdf",
    };
    for (const input of [
      { ...sample, Cc: [] },
      { ...sample, From: { Email: "invalid" } },
      ...[
        { ...attachment, Content: "not base64!" },
        { ...attachment, Content: "JVBER" },
        { ...attachment, Content: "JVBERg" },
        { ...attachment, Content: "JVBERh==" },
        { ...attachment, Content: "JVBE Rg==" },
        { Content: attachment.Content, ContentType: attachment.ContentType },
        { ...attachment, Filename: "" },
        { ...attachment, Filename: "agreement\r\n.pdf" },
        { ...attachment, Filename: "\uD800.pdf" },
        { ...attachment, Filename: `${"x".repeat(252)}.pdf` },
        { ...attachment, ContentType: "pdf" },
        { ...attachment, ContentType: "text/html\r\nSet-Cookie: a=b" },
        { ...attachment, ContentID: "agreement" },
      ].map((item) => ({ ...sample, Attachments: [item] })),
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
    const storage = await inbox(mf);
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
    await storage.exec("DROP TRIGGER fail_insert");
    await storage.exec(
      "CREATE TRIGGER fail_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    const partial = await mf.dispatchFetch("http://mailpint.test/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...sample,
        Attachments: [{ Content: base64("%PDF"), Filename: "agreement.pdf" }],
      }),
    });
    assert.equal(partial.status, 500);
    assert.equal((await listing(mf)).total, 1);
  } finally {
    await mf.dispose();
  }
});

test("attachments are listed, described and downloaded byte for byte", {
  timeout: 60_000,
}, async () => {
  const mf = await runtime();
  try {
    const plain = await capture(mf);
    const pdf = Uint8Array.from({ length: 256 }, (_, index) => index);
    const html = "<script>alert(1)</script>";
    const id = await capture(mf, {
      ...sample,
      Attachments: [
        {
          Content: base64(pdf),
          Filename: "Subscription agreement.pdf",
          ContentType: "application/pdf",
        },
        {
          Content: base64(html),
          Filename: 'Résumé "final" 100%.html',
          ContentType: "text/html; charset=utf-8",
        },
        { Content: "", Filename: "empty.bin" },
      ],
    });
    assert.deepEqual(
      (await listing(mf)).messages.map((message) => message.Attachments),
      [3, 0],
    );
    const detail = async (messageId: string) =>
      messageSchema.parse(
        await (
          await mf.dispatchFetch(
            `http://mailpint.test/api/v1/message/${messageId}`,
          )
        ).json(),
      );
    const message = await detail(id);
    assert.deepEqual(message.Attachments, [
      {
        PartID: "1",
        FileName: "Subscription agreement.pdf",
        ContentType: "application/pdf",
        ContentID: "",
        Size: 256,
      },
      {
        PartID: "2",
        FileName: 'Résumé "final" 100%.html',
        ContentType: "text/html; charset=utf-8",
        ContentID: "",
        Size: html.length,
      },
      {
        PartID: "3",
        FileName: "empty.bin",
        ContentType: "application/octet-stream",
        ContentID: "",
        Size: 0,
      },
    ]);
    assert.deepEqual(message.Inline, []);
    assert.equal(message.Size, (await detail(plain)).Size + 256 + html.length);

    const part = (path: string, method = "GET") =>
      mf.dispatchFetch(`http://mailpint.test/api/v1/message/${path}`, {
        method,
      });
    const first = await part(`${id}/part/1`);
    assert.equal(first.status, 200);
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), pdf);
    assert.equal(first.headers.get("Content-Type"), "application/pdf");
    assert.equal(
      first.headers.get("Content-Disposition"),
      "attachment; filename=\"Subscription agreement.pdf\"; filename*=UTF-8''Subscription%20agreement.pdf",
    );
    assert.equal(first.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(first.headers.get("Cache-Control"), "no-store");
    assert.equal(
      first.headers.get("Content-Security-Policy"),
      "default-src 'none'; sandbox",
    );
    const second = await part("latest/part/2");
    assert.equal(await second.text(), html);
    assert.equal(
      second.headers.get("Content-Type"),
      "text/html; charset=utf-8",
    );
    assert.equal(
      second.headers.get("Content-Disposition"),
      "attachment; filename=\"R_sum_ _final_ 100_.html\"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22%20100%25.html",
    );
    const empty = await part(`${id}/part/3`);
    assert.equal(empty.status, 200);
    assert.equal((await empty.arrayBuffer()).byteLength, 0);

    for (const path of [
      `${id}/part/4`,
      `${id}/part/0`,
      `${id}/part/01`,
      `${id}/part/x`,
      `${plain}/part/1`,
      `${crypto.randomUUID()}/part/1`,
    ]) {
      const response = await part(path);
      assert.equal(response.status, 404, path);
      await response.arrayBuffer();
    }
    assert.equal((await part(`invalid/part/1`)).status, 400);
    assert.equal((await part(`${id}/part/1?download=1`)).status, 400);
    const post = await part(`${id}/part/1`, "POST");
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("Allow"), "GET");
  } finally {
    await mf.dispose();
  }
});

test("version 1 inboxes upgrade in place and keep their messages", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailpint-test-"));
  let mf = await runtime(directory);
  try {
    const id = await capture(mf);
    // Reduce the inbox to the 0.1.0 schema, keeping its message.
    const storage = await inbox(mf);
    await storage.exec("DROP TABLE attachments");
    await storage.exec("UPDATE schema_version SET version = 1");
    await mf.dispose();
    mf = await runtime(directory);
    const restored = await listing(mf);
    assert.equal(restored.total, 1);
    assert.equal(restored.messages[0]?.ID, id);
    assert.equal(restored.messages[0]?.Attachments, 0);
    const detail = await mf.dispatchFetch(
      `http://mailpint.test/api/v1/message/${id}`,
    );
    const message = messageSchema.parse(await detail.json());
    assert.equal(message.HTML, sample.HTML);
    assert.deepEqual(message.Attachments, []);
    assert.deepEqual(
      await (await inbox(mf)).exec("SELECT version FROM schema_version"),
      [{ version: 2 }],
    );
    const attached = await capture(mf, {
      ...sample,
      Attachments: [{ Content: base64("%PDF"), Filename: "agreement.pdf" }],
    });
    const download = await mf.dispatchFetch(
      `http://mailpint.test/api/v1/message/${attached}/part/1`,
    );
    assert.equal(await download.text(), "%PDF");
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("deleting, expiring and evicting messages removes their attachments", {
  timeout: 120_000,
}, async () => {
  const mf = await runtime();
  try {
    const storage = await inbox(mf);
    const stored = async () =>
      (
        await storage.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM attachments",
        )
      )[0]?.count;
    const attached = (content: string) =>
      capture(mf, {
        ...sample,
        Attachments: [
          { Content: content, Filename: "a.bin" },
          { Content: content, Filename: "b.bin" },
        ],
      });
    const remove = (body?: string) =>
      mf.dispatchFetch("http://mailpint.test/api/v1/messages", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body }),
      });
    const ids = [
      await attached("AAAA"),
      await attached("AAAA"),
      await attached("AAAA"),
    ];
    assert.equal(await stored(), 6);
    assert.equal((await remove(JSON.stringify({ IDs: [ids[0]] }))).status, 200);
    assert.equal(await stored(), 4);
    await remove(JSON.stringify({ IDs: ids.slice(1) }));
    assert.equal(await stored(), 0);
    await attached("AAAA");
    await attached("AAAA");
    assert.equal((await remove()).status, 200);
    assert.equal(await stored(), 0);
    await attached("AAAA");
    await storage.exec("UPDATE messages SET received = 0");
    assert.equal((await listing(mf)).total, 0);
    assert.equal(await stored(), 0);

    // Attachment bytes alone exceed the inbox byte limit well below 500 messages.
    const large = base64(new Uint8Array(350_000));
    const oldest = await attached(large);
    for (let index = 0; index < 31; index++) await attached(large);
    const bounded = await listing(mf);
    assert.ok(bounded.total > 0 && bounded.total < 32);
    assert.equal(
      (await mf.dispatchFetch(`http://mailpint.test/api/v1/message/${oldest}`))
        .status,
      404,
    );
    assert.equal(await stored(), bounded.total * 2);
    const [usage] = await storage.exec<{ bytes: number; smallest: number }>(
      "SELECT SUM(bytes) AS bytes, MIN(bytes) AS smallest FROM messages",
    );
    assert.ok(usage && usage.bytes <= limits.storedBytes);
    assert.ok(usage.smallest > 700_000);
  } finally {
    await mf.dispose();
  }
});
