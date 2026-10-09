import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { assets } from "./assets.js";
import { deleteSchema, readSchema, sendSchema } from "./contracts.js";
import {
  commonHeaders,
  HttpError,
  json,
  methodNotAllowed,
  ok,
  pagination,
  readJson,
} from "./http.js";
import { preview } from "./preview.js";
import { MailboxStorage } from "./storage.js";

export interface MailpintEnv {
  MAILBOX: DurableObjectNamespace<Mailbox>;
}

export class Mailbox extends DurableObject<MailpintEnv> {
  private readonly mailbox: MailboxStorage;

  constructor(ctx: DurableObjectState, env: MailpintEnv) {
    super(ctx, env);
    this.mailbox = new MailboxStorage(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/api/v1/send") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        if (url.search) throw new HttpError(400, "Unsupported query parameter");
        return json(
          this.mailbox.capture(sendSchema.parse(await readJson(request))),
        );
      }
      if (path === "/api/v1/messages") {
        if (request.method === "GET") {
          const { start, limit } = pagination(url);
          return json(this.mailbox.list(start, limit));
        }
        if (url.search) throw new HttpError(400, "Unsupported query parameter");
        if (request.method === "PUT") {
          const input = readSchema.parse(await readJson(request));
          this.mailbox.setRead(input.IDs, input.Read);
          return ok();
        }
        if (request.method === "DELETE") {
          const input = deleteSchema.parse(await readJson(request, true));
          this.mailbox.delete(input.IDs);
          return ok();
        }
        return methodNotAllowed("GET, PUT, DELETE");
      }
      const detail = /^\/api\/v1\/message\/([^/]+)$/.exec(path);
      const view = /^\/view\/([^/]+)\.html$/.exec(path);
      const id = detail?.[1] ?? view?.[1];
      if (id) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        if (url.search) throw new HttpError(400, "Unsupported query parameter");
        if (id !== "latest") z.uuid().parse(id);
        const message = this.mailbox.get(id, !view);
        return view ? preview(message.HTML) : json(message);
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (error instanceof z.ZodError) {
        return json({ Error: "Invalid or unsupported request fields" }, 400);
      }
      if (error instanceof HttpError)
        return json({ Error: error.message }, error.status);
      // Never log message content, addresses, or storage/provider error details.
      console.error("Mailbox operation failed", { method: request.method });
      return json({ Error: "Mailbox operation failed" }, 500);
    }
  }
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/view/")) {
      return env.MAILBOX.get(env.MAILBOX.idFromName("inbox")).fetch(request);
    }
    const asset = assets[url.pathname];
    if (!asset) return json({ Error: "Not found" }, 404);
    if (!["GET", "HEAD"].includes(request.method))
      return methodNotAllowed("GET, HEAD");
    return new Response(request.method === "HEAD" ? null : asset.body, {
      headers: {
        ...commonHeaders,
        "Content-Type": asset.type,
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    });
  },
} satisfies ExportedHandler<MailpintEnv>;

export default worker;
