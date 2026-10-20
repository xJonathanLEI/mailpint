# Mailpint

A pint-sized development inbox for Cloudflare Workers. Captures email through a subset of the [Mailpit HTTP API](https://mailpit.axllent.org/docs/api-v1/), with a built-in web UI and SQLite storage in a Durable Object.

## Setup

Export the handler and Durable Object from your Worker:

```ts
export { default, Mailbox } from "mailpint/cloudflare";
```

Add the binding to your Wrangler configuration:

```json
{
  "name": "my-mailbox",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "durable_objects": {
    "bindings": [{ "name": "MAILBOX", "class_name": "Mailbox" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Mailbox"] }]
}
```

No separate database or frontend deployment is needed. Each Worker has its own inbox. See [`examples/worker`](examples/worker) for a complete host.

External HTTP(S) images load by default, including CSS backgrounds. To block them, add `"vars": { "MAILPINT_BLOCK_EXTERNAL_IMAGES": true }` to your Wrangler configuration. Boolean values and the strings `"true"` and `"false"` are accepted. Embedded raster images work in either mode.

## Usage

```sh
curl http://localhost:8787/api/v1/send \
  -H 'Content-Type: application/json' \
  -d '{
    "From": {"Name": "Example", "Email": "hello@example.test"},
    "To": [{"Email": "alex@example.test"}],
    "Subject": "Hello",
    "Text": "Hello from Mailpint",
    "HTML": "<p>Hello from Mailpint</p>"
  }'
```

Open the same URL in your browser to filter messages, view HTML or plain text, download attachments, mark messages unread, and delete them. Click Refresh to load new mail.

## API

| Endpoint                                 | Description                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/send`                      | Accepts `From`, `To`, `Subject`, `Text`, `HTML`, `Attachments`; returns `{"ID":"…"}`. Addresses have `Email` and optional `Name`. |
| `GET /api/v1/messages`                   | Lists newest first. Supports `start` and `limit` (default 50, maximum 500).                                                       |
| `GET /api/v1/message/{ID}`               | Retrieves a message and marks it read. Accepts `latest` as an ID.                                                                 |
| `GET /api/v1/message/{ID}/part/{PartID}` | Downloads an attachment. Accepts `latest` as an ID.                                                                               |
| `PUT /api/v1/messages`                   | Sets read state with `{"IDs":["…"],"Read":true}`. `Read` defaults to false.                                                       |
| `DELETE /api/v1/messages`                | Deletes messages with `{"IDs":["…"]}`. An empty body clears the inbox.                                                            |
| `GET /view/{ID}.html`                    | Serves a sandboxed HTML preview.                                                                                                  |

`Attachments` holds up to 100 `{"Content":"<base64>","Filename":"…","ContentType":"…"}` objects; `ContentType` defaults to `application/octet-stream`. Message summaries report the attachment count, and messages list each attachment's `PartID`, `FileName`, `ContentType`, `ContentID` (always empty) and decoded `Size`.

Omitted or empty `IDs` applies updates/deletions to the whole inbox. Unsupported fields and query parameters are rejected. SMTP, MIME ingestion, inline attachments (`ContentID`), Cc/Bcc, custom headers, tags, forwarding, and Mailpit search are not supported. Message `Size` is the stored JSON size plus decoded attachment bytes, not a MIME size.

Requests are limited to 1 MiB. The inbox keeps up to 500 messages and 20 MiB of message data, including attachments; messages expire after seven days, with cleanup on API access. HTML previews block scripts, forms, nested frames and external stylesheets; HTTP(S) links open in a new tab. Attachments are always served as sandboxed downloads, never rendered.

There is no authentication: anyone with the URL can send, read, and delete mail.

## Development

Use the Node version in `.node-version` and pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm dev
```

The example runs at `http://localhost:8787` with persistent local storage. Restart after source changes.

Run `pnpm validate` for linting, type checks, tests, and a Worker dry-run build. `pnpm test` runs the tests separately. Neither command deploys anything.

## Release

Push a `vX.Y.Z` tag on a commit in `master` matching the version in `package.json`. GitHub Actions validates the package and publishes it to npm using the `NPM_TOKEN` secret.
