import { join } from "node:path";
import { HOME } from "../core/platform";
import { exec, firstLine } from "../core/proc";
import { openReadOnly } from "../core/sqlite";
import type { SourceEvent } from "../records/source";
import { handleKey, readContacts } from "./contacts";
import type { Newest } from "./contract";
import { sourceFile } from "./contract";

// iMessage and SMS from the Mac's Messages database, opened read-only. Never written.

export const DB = join(HOME, "Library", "Messages", "chat.db");
const TILDE = /^~/;
// Messages stores dates as nanoseconds since 2001-01-01.
const APPLE_EPOCH_S = 978_307_200;

export const toAppleNs = (date: Date) =>
  BigInt(Math.floor(date.getTime() / 1000) - APPLE_EPOCH_S) * 1_000_000_000n;
export const fromAppleNs = (ns: number | bigint) =>
  new Date(Number(BigInt(ns) / 1_000_000n) + APPLE_EPOCH_S * 1000);
// Notes and WhatsApp store seconds since 2001-01-01; `ms` is a JavaScript time.
export const fromAppleS = (s: number) => new Date((s + APPLE_EPOCH_S) * 1000);
export const toAppleS = (ms: number) => ms / 1000 - APPLE_EPOCH_S;

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

/** Whether a chat is a group: a group's identifier is `chat…`, a 1:1 chat's its handle. */
export const isImessageGroup = (chat: string) => chat.startsWith("chat");
const HANDLE = /^(\+\d+|[^@\s]+@[^@\s]+)$/;
/** The handle a 1:1 chat's key is (a number or an address). */
export const handleOf = (key: string) => (HANDLE.test(key) ? key : undefined);

/** `names`: his Contacts, which name a 1:1 chat that has no name of its own (Messages keeps only the number). */
export function readImessage(
  since: Date,
  path = DB,
  names: Map<string, string> = readContacts()
): SourceEvent[] {
  const db = openReadOnly(path);
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
    return rows.map((r) => {
      // A chat Messages names (an empty name is none), else, for a 1:1 chat (its identifier a handle, a group's is
      // `chat…`), the name his Contacts give that handle: every message of the chat, his own included.
      const named =
        r.chatName ||
        (r.chat && !isImessageGroup(r.chat)
          ? names.get(handleKey(r.chat))
          : undefined);
      return {
        at: fromAppleNs(r.date).toISOString(),
        chat: r.chat ?? r.sender ?? "unknown",
        ...(named ? { chatName: named } : {}),
        files: (JSON.parse(r.files) as Parameters<typeof sourceFile>[0][]).map(
          (a) => sourceFile({ ...a, path: a.path?.replace(TILDE, HOME) })
        ),
        fromMe: r.fromMe === 1,
        id: `imessage:${r.guid}`,
        sender: r.fromMe === 1 ? "me" : (r.sender ?? "unknown"),
        source: "imessage" as const,
        text: r.text ?? textFromAttributedBody(r.attributedBody),
      };
    });
  } finally {
    db.close();
  }
}

/** The newest message in Messages (the status snapshot). */
export function newestImessage(): Newest {
  const db = openReadOnly(DB);
  try {
    const r = db
      .query<
        {
          attributedBody: Uint8Array | null;
          date: number | bigint;
          text: string | null;
        },
        []
      >(
        "select date, text, attributedBody from message order by date desc limit 1"
      )
      .get();
    return r
      ? {
          at: fromAppleNs(r.date).toISOString(),
          words: [r.text || textFromAttributedBody(r.attributedBody)],
        }
      : { at: null };
  } finally {
    db.close();
  }
}

/** The chat's id as Messages knows it (its guid), for `imsg`: the newest chat with that identifier. */
function guidOf(chat: string, path = DB) {
  const db = openReadOnly(path);
  try {
    const r = db
      .query<{ guid: string }, [string]>(
        "select guid from chat where chat_identifier = ? order by ROWID desc limit 1"
      )
      .get(chat);
    if (!r) {
      throw new Error(`no iMessage chat ${chat}`);
    }
    return r.guid;
  } finally {
    db.close();
  }
}

/**
 * iMessage's `send` (sources/contract.ts), through `imsg`'s JSON-RPC: the chat by its guid, the text as data, never
 * an argument. Messages has no transaction id: sending once is the ledger's `intent` line's job (`host/send.ts`).
 */
export const imessageSend = {
  async blocked() {
    const r = await exec(["imsg", "--version"], { timeout: 3000 });
    return r.code === 0
      ? undefined
      : `imsg not answering: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`;
  },
  async deliver(chat: string, text: string) {
    const ask = {
      id: 1,
      jsonrpc: "2.0",
      method: "send",
      params: { chat_guid: guidOf(chat), text },
    };
    // ponytail: no answer in 30 s is recorded as failed, though Messages may have sent it; imsg verifies each send.
    const line = await firstLine(
      ["imsg", "rpc"],
      `${JSON.stringify(ask)}\n`,
      (l) => l.includes('"id":1'),
      { timeout: 30_000 }
    );
    const answer = line
      ? (JSON.parse(line) as { error?: { message?: string } })
      : { error: { message: "no answer from imsg" } };
    if (answer.error) {
      throw new Error(`imsg: ${answer.error.message ?? "refused"}`);
    }
  },
};

/**
 * The chats someone else wrote in after message row `after` (none on the first call, which only takes the cursor),
 * and the new cursor: by row, so a message Messages stores late is never skipped.
 */
export function incomingImessage(after: number | undefined, path = DB) {
  const db = openReadOnly(path);
  try {
    const last =
      db
        .query<{ n: number | null }, []>("select max(ROWID) as n from message")
        .get()?.n ?? 0;
    const chats =
      after === undefined
        ? []
        : db
            .query<{ chat: string }, [number, number]>(
              `select distinct c.chat_identifier as chat from message m
                 join chat_message_join j on j.message_id = m.ROWID join chat c on c.ROWID = j.chat_id
                where m.ROWID > ? and m.ROWID <= ? and not m.is_from_me and m.item_type = 0`
            )
            .all(after, last)
            .map((r) => r.chat);
    return { chats, last };
  } finally {
    db.close();
  }
}
