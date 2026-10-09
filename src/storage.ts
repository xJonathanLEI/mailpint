import {
  type Listing,
  limits,
  type Message,
  type Submission,
  type Summary,
  summarySchema,
} from "./contracts.js";
import { HttpError } from "./http.js";

interface Row extends Record<string, SqlStorageValue> {
  id: string;
  summary: string;
  html: string;
  text: string;
  is_read: number;
}

export class MailboxStorage {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.transactionSync(() => {
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
      );
      const version =
        storage.sql
          .exec<{ version: number }>("SELECT version FROM schema_version")
          .toArray()[0]?.version ?? 0;
      if (version > 1)
        throw new Error("Mailbox schema is newer than this package");
      if (version === 0) {
        storage.sql.exec(`
          CREATE TABLE messages (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            received INTEGER NOT NULL,
            bytes INTEGER NOT NULL,
            is_read INTEGER NOT NULL DEFAULT 0,
            summary TEXT NOT NULL,
            html TEXT NOT NULL,
            text TEXT NOT NULL
          );
          CREATE INDEX messages_received ON messages(received);
          INSERT INTO schema_version VALUES (1);
        `);
      }
    });
  }

  private summary(row: Pick<Row, "summary" | "is_read">): Summary {
    return {
      ...summarySchema.parse(JSON.parse(row.summary)),
      Read: row.is_read === 1,
    };
  }

  private prune(now: number) {
    this.storage.sql.exec(
      "DELETE FROM messages WHERE received <= ?",
      now - limits.retentionMs,
    );
  }

  capture(input: Submission, now = Date.now()) {
    return this.storage.transactionSync(() => {
      this.prune(now);
      const ID = crypto.randomUUID();
      const MessageID = `${ID}@mailpint`;
      const size = new TextEncoder().encode(JSON.stringify(input)).byteLength;
      const summary: Summary = {
        ID,
        MessageID,
        From: input.From,
        To: input.To,
        Cc: [],
        Bcc: [],
        ReplyTo: [],
        Subject: input.Subject,
        Created: new Date(now).toISOString(),
        Read: false,
        Size: size,
        Snippet: input.Text.replace(/\s+/g, " ").trim().slice(0, 250),
        Attachments: 0,
        Tags: [],
        Username: "",
      };
      const serialized = JSON.stringify(summary);
      const bytes = new TextEncoder().encode(
        serialized + input.HTML + input.Text,
      ).byteLength;
      this.storage.sql.exec(
        "INSERT INTO messages (id, received, bytes, summary, html, text) VALUES (?, ?, ?, ?, ?, ?)",
        ID,
        now,
        bytes,
        serialized,
        input.HTML,
        input.Text,
      );
      // Keep the newest suffix satisfying both limits, atomically with capture.
      this.storage.sql.exec(
        `
        DELETE FROM messages WHERE sequence IN (
          SELECT sequence FROM (
            SELECT sequence, ROW_NUMBER() OVER (ORDER BY sequence DESC) AS position,
              SUM(bytes) OVER (ORDER BY sequence DESC) AS cumulative_bytes
            FROM messages
          ) WHERE position > ? OR cumulative_bytes > ?
        )
      `,
        limits.messages,
        limits.storedBytes,
      );
      return { ID };
    });
  }

  list(start: number, limit: number, now = Date.now()): Listing {
    return this.storage.transactionSync(() => {
      this.prune(now);
      const counts = this.storage.sql
        .exec<{ total: number; unread: number }>(
          "SELECT COUNT(*) AS total, COALESCE(SUM(1 - is_read), 0) AS unread FROM messages",
        )
        .one();
      const rows = this.storage.sql.exec<Pick<Row, "summary" | "is_read">>(
        "SELECT summary, is_read FROM messages ORDER BY sequence DESC LIMIT ? OFFSET ?",
        limit,
        start,
      );
      return {
        ...counts,
        start,
        messages_count: counts.total,
        messages_unread: counts.unread,
        tags: [],
        messages: rows.toArray().map((row) => this.summary(row)),
      };
    });
  }

  get(id: string, markRead = true, now = Date.now()): Message {
    const message = this.storage.transactionSync((): Message | null => {
      this.prune(now);
      const row = (
        id === "latest"
          ? this.storage.sql.exec<Row>(
              "SELECT * FROM messages ORDER BY sequence DESC LIMIT 1",
            )
          : this.storage.sql.exec<Row>(
              "SELECT * FROM messages WHERE id = ?",
              id,
            )
      ).toArray()[0];
      if (!row) return null;
      if (markRead)
        this.storage.sql.exec(
          "UPDATE messages SET is_read = 1 WHERE id = ?",
          row.id,
        );
      const {
        Read: _read,
        Created,
        Snippet: _snippet,
        Attachments: _attachments,
        ...rest
      } = this.summary(row);
      return {
        ...rest,
        Date: Created,
        HTML: row.html,
        Text: row.text,
        Attachments: [],
        Inline: [],
        ReturnPath: rest.From.Email,
      };
    });
    // Commit expiry cleanup even when the requested message is already gone.
    if (!message) throw new HttpError(404, "Message not found");
    return message;
  }

  setRead(ids: string[], read: boolean) {
    this.mutate(ids, "UPDATE messages SET is_read = ?", [Number(read)]);
  }

  delete(ids: string[]) {
    this.mutate(ids, "DELETE FROM messages", []);
  }

  private mutate(
    ids: string[],
    statement: string,
    parameters: SqlStorageValue[],
  ) {
    this.storage.transactionSync(() => {
      this.prune(Date.now());
      if (ids.length) {
        // Stay below SQLite's per-statement parameter limit.
        for (const id of ids)
          this.storage.sql.exec(`${statement} WHERE id = ?`, ...parameters, id);
      } else {
        this.storage.sql.exec(statement, ...parameters);
      }
    });
  }
}
