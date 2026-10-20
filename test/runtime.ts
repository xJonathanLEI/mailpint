import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { z } from "zod";
import { listingSchema, type sendSchema } from "../src/contracts.ts";

type Submission = z.input<typeof sendSchema>;

export const sample = {
  From: { Name: "Northstar", Email: "hello@northstar.test" },
  To: [{ Name: "", Email: "alex@example.test" }],
  Subject: "Your sign-in link",
  Text: "Sign in to Northstar\nhttps://northstar.test/sign-in?token=synthetic-preview",
  HTML: '<article style="padding:32px"><h1>Right back where you left off.</h1><a href="https://northstar.test/sign-in?token=synthetic-preview">Sign in to Northstar</a></article>',
} satisfies Submission;

export async function runtime(
  persist?: string,
  blockExternalImages?: boolean | "true" | "false",
) {
  const result = await build({
    stdin: {
      contents: 'export { default, Mailbox } from "./dist/cloudflare.js";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*"],
    target: "es2022",
  });
  const output = result.outputFiles[0];
  assert.ok(output);
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "mailpint-test",
          compatibilityDate: "2026-01-01",
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: output.text } },
          },
          exports: { Mailbox: { type: "durable-object", storage: "sqlite" } },
          env: {
            ...(blockExternalImages === undefined
              ? {}
              : {
                  MAILPINT_BLOCK_EXTERNAL_IMAGES: {
                    type: "json" as const,
                    value: blockExternalImages,
                  },
                }),
            MAILBOX: {
              type: "durable-object",
              worker: "mailpint-test",
              exportName: "Mailbox",
            },
          },
        },
      },
    ],
    resourcePersistencePath: persist,
    unsafeInspectDurableObjects: true,
    host: "127.0.0.1",
    port: 0,
  });
  try {
    await mf.ready;
    return mf;
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

export async function capture(mf: Miniflare, input: Submission = sample) {
  const response = await mf.dispatchFetch("http://mailpint.test/api/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return z.object({ ID: z.uuid() }).parse(await response.json()).ID;
}

export function inbox(mf: Miniflare) {
  return mf.unsafeGetDurableObjectStorage("mailpint-test", "Mailbox", {
    name: "inbox",
  });
}

export async function listing(mf: Miniflare, query = "?limit=500") {
  const response = await mf.dispatchFetch(
    `http://mailpint.test/api/v1/messages${query}`,
  );
  assert.equal(response.status, 200);
  return listingSchema.parse(await response.json());
}
