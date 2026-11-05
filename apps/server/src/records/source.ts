import { z } from "zod";
import { SourceName } from "../core/names";
import { isoDateTime } from "./fields";

// What a source reader gives: its events and their files.

/**
 * A file a message carries, as its source resolved it; message-files.ts renders it as a line of the message. `ref` says where
 * it was met, stable without the file: `imessage:<attachment guid>`, `whatsapp:<chat>/<msg>`, `line:<mxc url>`,
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
    // Mail only: his Contacts hold the sender's address.
    contact: z.literal(true).optional(),
    // WhatsApp and the bridged networks: the sender deleted it for everyone; the text is the archive's copy. Notes: he deleted the note.
    deleted: z.boolean().optional(),
    files: z.array(SourceFile).optional(),
    fromMe: z.boolean(),
    id: z.string(),
    // A phone call through the chat's network, a message of its chat: its length once it ended (0: not picked up),
    // none while it is on. Its text is the line Life writes for it (`callLine`, units.ts).
    phoneCall: z
      .object({ seconds: z.int().min(0).optional(), video: z.boolean() })
      .strict()
      .optional(),
    removed: z.int().min(0).optional(),
    // The sender's handle as the source shows it: phone, email, a network's participant id; git: the author's name.
    sender: z.string(),
    // lifelog has turns in the watcher's store, not events.
    source: SourceName.exclude(["lifelog"]),
    text: z.string(),
    // Mail only: Mail sorted it as a transaction (an order, booking, receipt, delivery or bank notice).
    transaction: z.literal(true).optional(),
    // Screen Time only: when the app or website left the front.
    until: isoDateTime.optional(),
  })
  .strict();

export type SourceEvent = z.infer<typeof SourceEvent>;
