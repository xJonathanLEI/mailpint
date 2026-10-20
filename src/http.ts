import { limits } from "./contracts.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const commonHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: commonHeaders });
}

export function ok() {
  return new Response("ok", {
    headers: { ...commonHeaders, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function contentDisposition(filename: string) {
  const fallback = filename.replace(/[^ -~]|["\\%]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function download(attachment: {
  content: ArrayBuffer;
  filename: string;
  contentType: string;
}) {
  return new Response(attachment.content, {
    headers: {
      ...commonHeaders,
      "Content-Type": attachment.contentType,
      "Content-Disposition": contentDisposition(attachment.filename),
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export function methodNotAllowed(allow: string) {
  return new Response("Method not allowed", {
    status: 405,
    headers: { ...commonHeaders, Allow: allow },
  });
}

// Bound the stream, not just the caller's Content-Length.
export async function readJson(
  request: Request,
  emptyAllowed = false,
): Promise<unknown> {
  const length = request.headers.get("Content-Length");
  if (length && Number(length) > limits.requestBytes) {
    throw new HttpError(413, "Message exceeds 1 MiB");
  }
  const reader = request.body?.getReader();
  if (!reader) {
    if (emptyAllowed) return {};
    throw new HttpError(400, "Expected a JSON body");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limits.requestBytes) {
        await reader.cancel();
        throw new HttpError(413, "Message exceeds 1 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0 && emptyAllowed) return {};
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new HttpError(415, "Expected application/json");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

export function pagination(url: URL) {
  for (const key of url.searchParams.keys()) {
    if (
      !["start", "limit"].includes(key) ||
      url.searchParams.getAll(key).length > 1
    ) {
      throw new HttpError(400, "Unsupported query parameter");
    }
  }
  const parse = (name: string, fallback: number, max: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) throw new HttpError(400, "Invalid pagination");
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > max) {
      throw new HttpError(400, "Invalid pagination");
    }
    return value;
  };
  const start = parse("start", 0, Number.MAX_SAFE_INTEGER);
  const limit = parse("limit", 50, limits.messages);
  if (limit === 0) throw new HttpError(400, "Limit must be positive");
  return { start, limit };
}
