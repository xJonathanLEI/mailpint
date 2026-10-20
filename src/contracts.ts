import { z } from "zod";

export const limits = {
  requestBytes: 1024 * 1024,
  messages: 500,
  storedBytes: 20 * 1024 * 1024,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

const header = z
  .string()
  .max(998)
  .regex(/^[^\r\n\0]*$/);
export const addressSchema = z.strictObject({
  Name: header.default(""),
  Email: z.email().max(254),
});

const base64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;
// A media type with optional parameters; empty means unspecified.
const mediaType = /^(?:[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?: *;[ -~]*)?)?$/;
const attachmentInputSchema = z.strictObject({
  Content: z
    .string()
    .regex(base64)
    .transform(
      (value) =>
        Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
          .buffer,
    ),
  Filename: header
    .min(1)
    .max(255)
    .regex(/^\P{Cs}*$/u),
  ContentType: z
    .string()
    .max(255)
    .regex(mediaType)
    .optional()
    .transform((value) => value || "application/octet-stream"),
});

export const sendSchema = z.strictObject({
  From: addressSchema,
  To: z.array(addressSchema).min(1).max(100),
  Subject: header.default(""),
  Text: z.string().default(""),
  HTML: z.string().default(""),
  Attachments: z.array(attachmentInputSchema).max(100).default([]),
});

const idSchema = z.uuid();
export const deleteSchema = z.strictObject({
  IDs: z.array(idSchema).max(limits.messages).default([]),
});
export const readSchema = deleteSchema.extend({
  Read: z.boolean().default(false),
});

export const summarySchema = z.object({
  ID: idSchema,
  MessageID: z.string(),
  From: addressSchema,
  To: z.array(addressSchema),
  Cc: z.array(addressSchema),
  Bcc: z.array(addressSchema),
  ReplyTo: z.array(addressSchema),
  Subject: z.string(),
  Created: z.iso.datetime(),
  Size: z.number().int().nonnegative(),
  Read: z.boolean(),
  Snippet: z.string(),
  Attachments: z.number().int().nonnegative(),
  Tags: z.array(z.string()),
  Username: z.string(),
});
const attachmentSchema = z.object({
  PartID: z.string(),
  FileName: z.string(),
  ContentType: z.string(),
  ContentID: z.string(),
  Size: z.number().int().nonnegative(),
});
export const messageSchema = summarySchema
  .omit({
    Created: true,
    Read: true,
    Snippet: true,
    Attachments: true,
  })
  .extend({
    Date: z.iso.datetime(),
    HTML: z.string(),
    Text: z.string(),
    Attachments: z.array(attachmentSchema),
    Inline: z.array(z.never()),
    ReturnPath: z.string(),
  });
export const listingSchema = z.object({
  messages: z.array(summarySchema).max(limits.messages),
  messages_count: z.number().int().nonnegative(),
  messages_unread: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  tags: z.array(z.string()),
});

export type Submission = z.infer<typeof sendSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type Message = z.infer<typeof messageSchema>;
export type Listing = z.infer<typeof listingSchema>;
