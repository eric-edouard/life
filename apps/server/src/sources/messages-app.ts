import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { clock } from "../core/clock";
import { FULL_DISK, unreadable } from "../core/files";
import { HOME } from "../core/platform";
import { exec } from "../core/proc";
import { openReadOnly } from "../core/sqlite";
import type { Outgoing, SendPath } from "./contract";
import { DB, messageIdOf, textFromAttributedBody, toAppleNs } from "./imessage";

// The one iMessage send: Messages.app does it, told by osascript (the only place Life names that app,
// `scripts/imports.test.ts`), and Life reads chat.db to see that it went. One macOS grant: Automation, Life →
// Messages, asked at the first send.

/**
 * Where a file is written for Messages to read: a folder of the user's own that the app can open (a sandboxed app
 * can't read Life's state folder). A fresh folder for each send, removed after it. ponytail: ~/Pictures, a folder
 * macOS asks nothing for; if Messages ever refuses it, the send reads `not sent` and this is the knob.
 */
const STAGING = join(HOME, "Pictures", "Life sends");
/** How long a text is waited for; a file's upload gets three times as much, as the Matrix send's 60 s does. */
const CONFIRM_MS = 20_000;
const POLL_MS = 500;
const NO_ACCESS = "-1743";

interface Run {
  code: number;
  killed: unknown;
  stderr: string;
}
interface Options {
  confirmMs?: number;
  /** The chat database. */
  db?: string;
  pollMs?: number;
  /** Runs one program (osascript). */
  run?: (cmd: string[]) => Promise<Run>;
  staging?: string;
}

/** What the chat's newest row of mine says about a message sent since `from` (Apple ns): its guid, whether Messages sent it and its error. */
interface Sent {
  attributedBody: Uint8Array | null;
  error: number;
  files: string | null;
  guid: string;
  sent: number;
  text: string | null;
}

/** The send path of iMessage and SMS chats into Messages.app (`Descriptor.send`). */
export function messagesAppSend({
  confirmMs = CONFIRM_MS,
  pollMs = POLL_MS,
  db: path = DB,
  run = (cmd) => exec(cmd),
  staging = STAGING,
}: Options = {}): SendPath {
  const read = <T>(f: (db: ReturnType<typeof openReadOnly>) => T) => {
    const db = openReadOnly(path);
    try {
      return f(db);
    } finally {
      db.close();
    }
  };
  /** The guid of the chat whose identifier is `chat`: the one with the newest message when services share it. */
  const guidOf = (chat: string) =>
    read(
      (db) =>
        db
          .query<{ guid: string }, [string]>(
            `select guid from chat c where chat_identifier = ? and guid is not null
              order by (select max(m.date) from chat_message_join j join message m on m.ROWID = j.message_id
                         where j.chat_id = c.ROWID) desc limit 1`
          )
          .get(chat)?.guid
    );
  /** The message of mine in chat `guid`, since `from`, that carries `text` or a file named `name`: waited for until Messages marks it sent (or reports an error). */
  const confirmed = async (
    guid: string,
    from: bigint,
    what: { name: string } | { text: string },
    end: number
  ): Promise<string> => {
    const rows = read((db) =>
      db
        .query<Sent, [string, bigint]>(
          `select m.guid, m.text, m.attributedBody, m.error, m.is_sent as sent,
                    (select json_group_array(a.transfer_name) from message_attachment_join j
                       join attachment a on a.ROWID = j.attachment_id where j.message_id = m.ROWID) as files
               from message m join chat_message_join cmj on cmj.message_id = m.ROWID
               join chat c on c.ROWID = cmj.chat_id
              where c.guid = ? and m.is_from_me = 1 and m.date >= ? order by m.date`
        )
        .all(guid, from)
    );
    const row = rows.find((r) =>
      "name" in what
        ? (JSON.parse(r.files ?? "[]") as string[]).includes(what.name)
        : (r.text || textFromAttributedBody(r.attributedBody)).trim() ===
          what.text.trim()
    );
    // Messages writes the row before the message goes and sets `error` or `is_sent` later.
    if (row?.error) {
      throw new Error(`not sent: Messages reports error ${row.error}`);
    }
    if (row?.sent) {
      return row.guid;
    }
    if (performance.now() > end) {
      throw new Error(
        "may have gone: Messages didn't show it in the chat in time: read the chat"
      );
    }
    await Bun.sleep(pollMs);
    return confirmed(guid, from, what, end);
  };
  /** Tells Messages to send `what` into chat `guid`, and waits to see it. */
  const tell = async (
    guid: string,
    what: { name: string; path: string } | { text: string }
  ) => {
    const from = toAppleNs(clock());
    const file = "path" in what;
    const r = await run([
      "osascript",
      "-e",
      "on run {g, t}",
      "-e",
      file
        ? 'tell application "Messages" to send (POSIX file t) to chat id g'
        : 'tell application "Messages" to send t to chat id g',
      "-e",
      "end run",
      guid,
      file ? what.path : what.text,
    ]);
    if (r.killed) {
      throw new Error("may have gone: Messages didn't answer: read the chat");
    }
    if (r.code !== 0) {
      throw new Error(
        `not sent: ${r.stderr.trim().slice(-300)}${r.stderr.includes(NO_ACCESS) ? " (allow Life to control Messages: System Settings → Privacy & Security → Automation → Life → Messages)" : ""}`
      );
    }
    return confirmed(
      guid,
      from,
      file ? { name: what.name } : what,
      performance.now() + (file ? 3 : 1) * confirmMs
    );
  };
  return {
    block: () => Promise.resolve(unreadable(path, FULL_DISK)),
    holds: (chats) =>
      read((db) =>
        db
          .query<{ id: string }, [string]>(
            `select distinct chat_identifier as id from chat
              where guid is not null and chat_identifier in (select value from json_each(?))`
          )
          .all(JSON.stringify(chats))
          .map((r) => r.id)
      ),
    refusal: (d: Outgoing) =>
      Promise.resolve(
        d.onMessage || d.reaction || d.mentions
          ? "iMessage sends text and one file"
          : undefined
      ),
    send: async (d) => {
      const guid = guidOf(d.chat);
      if (!guid) {
        throw new Error("not sent: Messages holds no chat for this handle");
      }
      let last: string | undefined;
      if (d.file) {
        await mkdir(staging, { recursive: true });
        const folder = await mkdtemp(join(staging, "send-"));
        const name = basename(d.file.name);
        try {
          await Bun.write(join(folder, name), d.file.bytes);
          last = await tell(guid, { name, path: join(folder, name) });
        } finally {
          await rm(folder, { force: true, recursive: true });
        }
      }
      if (d.text) {
        try {
          last = await tell(guid, { text: d.text });
        } catch (e) {
          if (!d.file) {
            throw e;
          }
          const m = (e as Error).message;
          throw new Error(
            `may have gone: the file was sent, ${m.startsWith("not sent") ? "the text was not sent" : "the text may have gone"} (${m})`,
            { cause: e }
          );
        }
      }
      return messageIdOf(last as string);
    },
  };
}
