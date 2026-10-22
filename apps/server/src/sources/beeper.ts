import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { APP_DATA } from "../core/platform";
import type { SourceEvent } from "../records/source";
import {
  ARCHIVE,
  insertAll,
  newestArchived,
  openArchive,
  phoneMap,
  type Row,
  readArchived,
} from "./archived";
import { sourceFile } from "./contract";

// Beeper Desktop's own store, opened read-only by its copy into the archive.
export const BEEPER = join(APP_DATA, "BeeperTexts");

// LINE, Telegram and Instagram (the chats Beeper Desktop bridges) from Life's own archive. Beeper's API is not used: it
// only works while Beeper runs and keeps no deleted text.

// Of a message's versions, the latest with a text or not deleted (a photo has no text), with its latest files.
const SQL = `select m.id, m.chat, m.chatName, m.sender, m.fromMe, m.at, m.text, f.files,
    exists (select 1 from deleted d where d.chat = m.chat and d.eventId = m.eventId) as deleted
  from messages m left join files f on f.rowid = (select max(rowid) from files x
    where x.chat = m.chat and x.eventId = m.eventId)
  where m.at >= ?
    and m.rowid = (select max(x.rowid) from messages x
      where x.chat = m.chat and x.eventId = m.eventId and (x.text <> '' or not x.deleted))`;

/** Telegram senders are Matrix ids; the bridge knows the phone behind each. */
const telegramPhones = (beeper: string) =>
  phoneMap(
    join(beeper, "local-telegram/megabridge.db"),
    `select distinct m.sender_mxid as key, i.value as phone from message m
       join ghost g on g.bridge_id = m.bridge_id and g.id = m.sender_id, json_each(g.identifiers) i
      where i.value like 'tel:%'`
  );

// Beeper caches mxc://<host>/<id> at media/<host>/<id>, localmxc://<bridge>/<id> at media/localhost<bridge>/<id>.
const MXC = /^(local)?mxc:\/\/([^?]+)/;

interface Attachment {
  fileName?: string;
  id: string;
  isVoiceNote?: boolean;
  mimeType?: string;
  srcURL?: string;
}

/** A message's attachments as files, at Beeper's cached copy when it fetched one. Beeper types a voice note video/mp4. */
const filesOf = (beeper: string, json: string | null) =>
  (JSON.parse(json ?? "[]") as Attachment[]).map((a) => {
    const m = (a.srcURL ?? a.id).match(MXC);
    return sourceFile({
      mime: a.isVoiceNote ? "audio/mp4" : a.mimeType,
      name: a.fileName,
      path: m && join(beeper, "media", `${m[1] ? "localhost" : ""}${m[2]}`),
      ref: `beeper:${a.id}`,
    });
  });

/** Messages since `since` as events, oldest first. The sender is `+<phone>` when known, else the Matrix id. */
export function readBeeper(
  since: Date,
  archive = ARCHIVE,
  beeper = BEEPER
): SourceEvent[] {
  const phones = telegramPhones(beeper);
  return readArchived<Row & { files: string | null }>(
    "beeper",
    SQL,
    since,
    archive,
    (s) => phones.get(s) ?? s,
    (r) => ({ files: filesOf(beeper, r.files) })
  );
}

/** Each network's newest message the archive holds (the status plate). */
export const newestBeeper = (dir = ARCHIVE) =>
  newestArchived(
    "beeper",
    `select network as label, at, network || ': ' || coalesce(chatName, '?') || ': ' || text as words
     from (select *, row_number() over (partition by network order by at desc) as n from messages)
     where n = 1 order by at desc`,
    dir
  );

const LOCAL = /^local-/;

interface BeeperRow {
  account: string;
  chat: string;
  chatName: string | null;
  deleted: number;
  eventId: string;
  files: string | null;
  fromMe: number;
  id: number;
  sender: string | null;
  senderName: string | null;
  text: string;
  ts: number;
  type: string;
}

// Beeper Desktop's index.db holds every message it has synced for LINE, Telegram and Instagram (iMessage is read from
// chat.db, WhatsApp from its own app). `id` is the number Beeper's API calls the message id. A DM has no title, so it
// is named by the other person. Reactions and hidden events carry no text. `files` is the attachments' JSON, if any.
const BEEPER_SQL = `select m.id, m.eventID as eventId, m.roomID as chat, t.accountID as account,
    coalesce(json_extract(t.thread, '$.title'),
      (select group_concat(q.full_name, ', ') from participants q where q.room_id = t.threadID and not coalesce(q.is_self, 0))) as chatName,
    m.senderContactID as sender, p.full_name as senderName, m.isSentByMe as fromMe, m.timestamp as ts, m.type,
    coalesce(json_extract(m.message, '$.text'), '') as text, m.isDeleted as deleted,
    nullif(json_extract(m.message, '$.attachments'), '[]') as files
  from mx_room_messages m
  join threads t on t.threadID = m.roomID
  left join participants p on p.room_id = m.roomID and p.id = m.senderContactID
 where m.type not in ('HIDDEN', 'REACTION')
   and (t.accountID = 'line' or t.accountID like 'local-telegram%' or t.accountID like 'local-instagram%')`;

// One row per version a message was seen in: the original, each edit, and the deleted state (text wiped). The same for
// its attachments in `files`, which a delete wipes too.
const openBeeper = (dir: string) =>
  openArchive(
    dir,
    "beeper",
    `create table if not exists messages (
    id integer not null, eventId text not null, chat text not null, chatName text, network text not null,
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
       and (m.text <> '' or exists (select 1 from files f where f.chat = m.chat and f.eventId = m.eventId))`
  );

/** Copies new and changed LINE, Telegram and Instagram messages into the archive. Returns how many versions were new. */
export function copyBeeper(
  source = BEEPER,
  dir = ARCHIVE,
  now = clock().getTime()
): number {
  const path = join(source, "index.db");
  if (!existsSync(path)) {
    return 0;
  }
  const archive = openBeeper(dir);
  const beeper = new Database(path, { readonly: true });
  try {
    // The whole table every time, which also backfills the first run: a few thousand rows, and Beeper backfills old
    // chats into it at any time. Rows already archived are ignored.
    const rows = beeper.query<BeeperRow, []>(BEEPER_SQL).all();
    const seenAt = new Date(now).toISOString();
    const files = insertAll(
      archive,
      "insert or ignore into files (chat, eventId, files) values (?, ?, ?)",
      rows.flatMap((r) => (r.files ? [[r.chat, r.eventId, r.files]] : []))
    );
    const messages = insertAll(
      archive,
      `insert or ignore into messages (id, eventId, chat, chatName, network, sender, senderName, fromMe, at, type, text, deleted, seenAt)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows.map((r) => [
        ...[r.id, r.eventId, r.chat, r.chatName],
        r.account.replace(LOCAL, "").split("_")[0] ?? r.account,
        ...[r.sender, r.senderName, r.fromMe, new Date(r.ts).toISOString()],
        ...[r.type, r.text, r.deleted, seenAt],
      ])
    );
    return files + messages;
  } finally {
    beeper.close();
    archive.close();
  }
}
