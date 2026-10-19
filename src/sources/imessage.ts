import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { type SourceEvent, sourceFile } from "../schema";

// iMessage and SMS from the Mac's Messages database, opened read-only. Never written.

const DB = join(homedir(), "Library", "Messages", "chat.db");
const HOME = /^~/;
// Messages stores dates as nanoseconds since 2001-01-01.
export const APPLE_EPOCH_S = 978_307_200;

export const toAppleNs = (date: Date) =>
  BigInt(Math.floor(date.getTime() / 1000) - APPLE_EPOCH_S) * 1_000_000_000n;
export const fromAppleNs = (ns: number | bigint) =>
  new Date(Number(BigInt(ns) / 1_000_000n) + APPLE_EPOCH_S * 1000);

/** Newer messages keep their text only in an archived NSAttributedString; pull the first string out of it. */
export function textFromAttributedBody(blob: Uint8Array | null): string {
  if (!blob) {
    return "";
  }
  const bytes = Buffer.from(blob);
  const marker = bytes.indexOf("NSString");
  if (marker < 0) {
    return "";
  }
  // After "NSString" come 5 bytes of class info, then a length (1 byte, or 0x81 + 2 bytes LE), then UTF-8.
  let i = marker + "NSString".length + 5;
  let length = bytes[i] ?? 0;
  i += 1;
  if (length === 0x81) {
    length = bytes.readUInt16LE(i);
    i += 2;
  }
  return bytes.subarray(i, i + length).toString("utf8");
}

interface Row {
  attributedBody: Uint8Array | null;
  chat: string | null;
  chatName: string | null;
  date: number;
  // JSON: the message's attachments, link previews left out.
  files: string;
  fromMe: number;
  guid: string;
  sender: string | null;
  text: string | null;
}

export function readImessage(since: Date, path = DB): SourceEvent[] {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query<Row, [bigint]>(
        `select m.guid, m.date, m.is_from_me as fromMe, m.text, m.attributedBody,
                h.id as sender, c.chat_identifier as chat, c.display_name as chatName,
                (select json_group_array(json_object('ref', 'imessage:' || a.guid, 'mime', a.mime_type,
                        'name', a.transfer_name, 'path', a.filename))
                   from message_attachment_join j join attachment a on a.ROWID = j.attachment_id
                  where j.message_id = m.ROWID and not a.hide_attachment) as files
           from message m
           left join handle h on h.ROWID = m.handle_id
           left join chat_message_join cmj on cmj.message_id = m.ROWID
           left join chat c on c.ROWID = cmj.chat_id
          where m.date >= ? and m.item_type = 0
          order by m.date`
      )
      .all(toAppleNs(since));
    return rows.map((r) => ({
      at: fromAppleNs(r.date).toISOString(),
      chat: r.chat ?? r.sender ?? "unknown",
      ...(r.chatName ? { chatName: r.chatName } : {}),
      files: (JSON.parse(r.files) as Parameters<typeof sourceFile>[0][]).map(
        (a) => sourceFile({ ...a, path: a.path?.replace(HOME, homedir()) })
      ),
      fromMe: r.fromMe === 1,
      id: `imessage:${r.guid}`,
      sender: r.fromMe === 1 ? "me" : (r.sender ?? "unknown"),
      source: "imessage" as const,
      text: r.text ?? textFromAttributedBody(r.attributedBody),
    }));
  } finally {
    db.close();
  }
}
