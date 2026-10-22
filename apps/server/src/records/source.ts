import { existsSync } from "node:fs";
import { z } from "zod";
import { SourceName } from "../core/names";
import { isoDateTime } from "./fields";

// What a source reader gives: its events and their files.

/**
 * A file a message carries, as its source resolved it; message-files.ts renders it as a line of the message. `ref` says where
 * it was met, stable without the file: `imessage:<attachment guid>`, `whatsapp:<chat>/<msg>`, `beeper:<mxc url>`,
 * `mail:<Message-ID>#<IMAP part>`, `notes:<attachment id>`.
 */
export const SourceFile = z
  .object({
    mime: z.string(),
    name: z.string().optional(),
    // The file on this Mac (mail: the .emlx when the part is inside it); absent when it is not here.
    path: z.string().optional(),
    ref: z.string(),
  })
  .strict();

export type SourceFile = z.infer<typeof SourceFile>;

/**
 * A file as every reader makes one: typed by its name or path when the source gives no type (or only "bytes", as mail
 * often types a PDF), `path` only if it is there.
 */
export const sourceFile = (f: {
  mime?: string | null;
  name?: string | null;
  path?: string | null;
  ref: string;
}): SourceFile => ({
  mime:
    (f.mime !== "application/octet-stream" && f.mime) ||
    Bun.file(f.name || f.path || "").type,
  ...(f.name ? { name: f.name } : {}),
  ...(f.path && existsSync(f.path) ? { path: f.path } : {}),
  ref: f.ref,
});

/** A normalized source event. Ids are stable per source, so syncing twice never duplicates. */
export const SourceEvent = z
  .object({
    // Git only: lines a commit added and removed, lockfiles and generated files left out.
    added: z.int().min(0).optional(),
    at: isoDateTime,
    // Mail only: Mail saw a mailing-list id or an unsubscribe link, i.e. a newsletter or a marketing send.
    bulk: z.boolean().optional(),
    chat: z.string(),
    chatName: z.string().optional(),
    // WhatsApp and Beeper: the sender deleted it for everyone; the text is the archive's copy. Notes: he deleted the note.
    deleted: z.boolean().optional(),
    files: z.array(SourceFile).optional(),
    fromMe: z.boolean(),
    id: z.string(),
    removed: z.int().min(0).optional(),
    // The sender's handle as the source shows it: phone, email, Beeper participant id; git: the author's name.
    sender: z.string(),
    // lifelog has chapters, not events.
    source: SourceName.exclude(["lifelog"]),
    text: z.string(),
  })
  .strict();

export type SourceEvent = z.infer<typeof SourceEvent>;
