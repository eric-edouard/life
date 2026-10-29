import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_DIR } from "../core/platform";
import { openReadOnly } from "../core/sqlite";
import type { SourceEvent, SourceFile } from "../records/source";
import type { Newest } from "./contract";

// Life's archive (apps/server/src/host/archive.ts): opening a store to copy into it, and reading it back read-only: WhatsApp and the bridges'
// chats, a message deleted for everyone with the text the archive kept, an edited one by its latest text; each version
// of a note as what it changed.

export const ARCHIVE = join(MACHINE_DIR, "archive");

/** One archive store's database (an archived source's name). */
export const archiveDb = (name: string, dir = ARCHIVE) =>
  join(dir, `${name}.sqlite`);

/**
 * A store's newest items as the status snapshot shows them: `sql` gives rows newest first, each its `at`, his `words` and,
 * for a store with parts, a `label`.
 */
export function newestArchived(
  name: SourceEvent["source"],
  sql: string,
  dir = ARCHIVE
): Newest {
  const db = openReadOnly(archiveDb(name, dir));
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
  const db = openReadOnly(path);
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
  source: SourceEvent["source"],
  sql: string,
  since: Date,
  archive: string,
  sender: (raw: string) => string,
  more: (r: R) => { files: SourceFile[]; text?: string }
): SourceEvent[] {
  const db = openReadOnly(archiveDb(source, archive));
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

/** An archive store in `dir`, its tables created and its `deleted` view made again by `schema`. */
export function openArchive(dir: string, name: string, schema: string) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(archiveDb(name, dir));
  db.run("pragma journal_mode = wal");
  db.run(schema);
  return db;
}

/** Inserts each row's values in one transaction (an `insert or ignore` skips versions already archived); how many were new. */
export function insertAll(
  db: Database,
  sql: string,
  rows: SQLQueryBindings[][]
) {
  const insert = db.prepare(sql);
  let added = 0;
  db.transaction(() => {
    for (const values of rows) {
      added += insert.run(...values).changes;
    }
  })();
  return added;
}

/**
 * A Matrix-shaped chat archive (each bridge's, `sources/bridged.ts`): one row per version a message was
 * seen in (the original, each edit, the deleted state with its text wiped), the same for its files, which a delete
 * wipes too, and the `deleted` view. `extra` is the store's own columns, after `chatName`.
 */
export const matrixArchive = (
  extra: string
) => `create table if not exists messages (
    id integer not null, eventId text not null, chat text not null, chatName text, ${extra}
    sender text, senderName text, fromMe integer not null, at text not null, type text not null,
    text text not null, deleted integer not null, seenAt text not null,
    unique (chat, eventId, text, deleted));
  create table if not exists files (chat text not null, eventId text not null, files text not null,
    unique (chat, eventId, files));
  drop view if exists deleted;
  create view deleted as
    select m.*, d.seenAt as deletedSeenAt from messages m
      join messages d on d.chat = m.chat and d.eventId = m.eventId and d.deleted = 1
     where m.deleted = 0
       and (m.text <> '' or exists (select 1 from files f where f.chat = m.chat and f.eventId = m.eventId))`;

/** From a Matrix-shaped archive: of each message's versions, the latest with a text or not deleted (a photo has no text), with its latest files. */
export const LATEST_VERSIONS = `select m.id, m.chat, m.chatName, m.sender, m.fromMe, m.at, m.text, f.files,
    exists (select 1 from deleted d where d.chat = m.chat and d.eventId = m.eventId) as deleted
  from messages m left join files f on f.rowid = (select max(rowid) from files x
    where x.chat = m.chat and x.eventId = m.eventId)
  where m.at >= ?
    and m.rowid = (select max(x.rowid) from messages x
      where x.chat = m.chat and x.eventId = m.eventId and (x.text <> '' or not x.deleted))`;
