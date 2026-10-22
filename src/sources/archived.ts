import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SourceEvent, SourceFile } from "../schema";
import { MAC } from "../truth";
import type { Newest } from "./index";

// Reading Life's archive (src/archive.ts), opened read-only: WhatsApp and Beeper's chats, a message deleted for everyone
// with the text the archive kept, an edited one by its latest text; each version of a note as what it changed.

export const ARCHIVE = join(MAC, "archive");

// The apps' own stores the archive copies from (WhatsApp's and Beeper's), opened read-only.
export const WHATSAPP = join(
  homedir(),
  "Library/Group Containers/group.net.whatsapp.WhatsApp.shared"
);
export const BEEPER = join(
  homedir(),
  "Library/Application Support/BeeperTexts"
);

/** One archive store's database (`STORES` names them). */
export const archiveDb = (name: string, dir = ARCHIVE) =>
  join(dir, `${name}.sqlite`);

/**
 * A store's newest items as the status page shows them: `sql` gives rows newest first, each its `at`, his `words` and,
 * for a store with parts, a `label`.
 */
export function newestArchived(
  name: "beeper" | "notes" | "whatsapp",
  sql: string,
  dir = ARCHIVE
): Newest {
  const db = new Database(archiveDb(name, dir), { readonly: true });
  try {
    const rows = db
      .query<{ at: string; label?: string; words: string }, []>(sql)
      .all();
    return {
      at: rows[0]?.at ?? null,
      parts: rows.flatMap((r) =>
        r.label ? [{ at: r.at, label: r.label }] : []
      ),
      words: rows.map((r) => r.words),
    };
  } finally {
    db.close();
  }
}

const MARKS = /[‪-‮]/g;

/** `key` -> `+<digits>` from the `key` and `phone` columns of `sql`, read from an app's store. {} if it is not there. */
export function phoneMap(path: string, sql: string) {
  const phones = new Map<string, string>();
  if (!existsSync(path)) {
    return phones;
  }
  const db = new Database(path, { readonly: true });
  try {
    for (const r of db.query<{ key: string; phone: string }, []>(sql).all()) {
      phones.set(r.key, `+${r.phone.replace(/\D/g, "")}`);
    }
  } finally {
    db.close();
  }
  return phones;
}

export interface Row {
  at: string;
  chat: string;
  chatName: string | null;
  deleted: number;
  fromMe: number;
  id: number | string;
  sender: string | null;
  text: string;
}

/**
 * The messages `sql` reads from `<archive>/<source>.sqlite` since `since`, as events, oldest first. `sender` turns the
 * sender the archive holds into a handle (a phone when known); `more` gives a row's files (and a text of its own).
 */
export function readArchived<R extends Row>(
  source: "beeper" | "notes" | "whatsapp",
  sql: string,
  since: Date,
  archive: string,
  sender: (raw: string) => string,
  more: (r: R) => { files: SourceFile[]; text?: string }
): SourceEvent[] {
  const db = new Database(archiveDb(source, archive), {
    readonly: true,
  });
  try {
    return db
      .query<R, [string]>(sql)
      .all(since.toISOString())
      .map(
        (r): SourceEvent => ({
          at: r.at,
          chat: r.chat,
          chatName: r.chatName?.replace(MARKS, "").trim() || undefined,
          ...(r.deleted ? { deleted: true } : {}),
          fromMe: r.fromMe === 1,
          id: `${source}:${r.chat}/${r.id}`,
          sender: r.fromMe ? "me" : sender(r.sender ?? ""),
          source,
          text: r.text,
          ...more(r),
        })
      )
      .sort((a, b) => a.at.localeCompare(b.at));
  } finally {
    db.close();
  }
}
