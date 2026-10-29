import { existsSync } from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { APP_DATA } from "../core/platform";
import { openReadOnly } from "../core/sqlite";
import type { SourceEvent } from "../records/source";
import {
  ARCHIVE,
  archiveDb,
  insertAll,
  LATEST_VERSIONS,
  matrixArchive,
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
  const bridged = bridgedFrom(archive);
  return readArchived<Row & { files: string | null }>(
    "beeper",
    LATEST_VERSIONS,
    since,
    archive,
    (s) => phones.get(s) ?? s,
    (r) => ({ files: filesOf(beeper, r.files) })
  ).filter((e) => {
    const from = bridged.get(e.chat);
    return !(from && e.at >= from);
  });
}

/**
 * Beeper's chats of each network Life now bridges itself (`sources/bridged.ts`), by chat: from that archive's first
 * message on, its own source reads them, so Beeper's copy stops counting there. Beeper keeps copying everything, so a
 * bridge that is down loses nothing. Milestone 5 of the no-Beeper plan deletes this with Beeper's copy.
 */
function bridgedFrom(archive: string) {
  const from = new Map<string, string>();
  const beeper = archiveDb("beeper", archive);
  for (const network of ["line", "instagram"]) {
    const own = archiveDb(network, archive);
    if (!(existsSync(own) && existsSync(beeper))) {
      continue;
    }
    const first = withDb(
      own,
      (db) =>
        db
          .query<{ at: string | null }, []>(
            "select min(at) as at from messages"
          )
          .get()?.at
    );
    if (!first) {
      continue;
    }
    for (const { chat } of withDb(beeper, (db) =>
      db
        .query<{ chat: string }, [string]>(
          "select distinct chat from messages where network = ?"
        )
        .all(network)
    )) {
      from.set(chat, first);
    }
  }
  return from;
}

function withDb<T>(
  path: string,
  read: (db: ReturnType<typeof openReadOnly>) => T
) {
  const db = openReadOnly(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Each network's newest message the archive holds (the status snapshot). */
export const newestBeeper = (dir = ARCHIVE) =>
  newestArchived(
    "beeper",
    `select network as label, at, network || ': ' || coalesce(chatName, '?') || ': ' || text as words
     from (select *, row_number() over (partition by network order by at desc) as n from messages)
     where n = 1 order by at desc`,
    dir
  );

// The networks read from Beeper. Beeper names an account `local-<network>_<id>` (a bridge on this Mac), `<network>.<id>`
// (a bridge on its servers, which LINE moved to after 17 Oct 2026) or `<network>`.
const NETWORKS = ["line", "telegram", "instagram"].map((name) => ({
  form: new RegExp(`^(local-${name}(_|$)|${name}(\\.|$))`),
  name,
}));

/** The network of a Beeper account id, or null for one Life doesn't read (WhatsApp, iMessage: their own sources). */
const networkOf = (account: string) =>
  NETWORKS.find((n) => n.form.test(account))?.name ?? null;

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
 where m.type not in ('HIDDEN', 'REACTION')`;

// Beeper's archive: the Matrix-shaped versions table, each row with its network.
const openBeeper = (dir: string) =>
  openArchive(dir, "beeper", matrixArchive("network text not null,"));

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
  const beeper = openReadOnly(path);
  try {
    // The whole table every time, which also backfills the first run: a few thousand rows, and Beeper backfills old
    // chats into it at any time. Rows already archived are ignored.
    const rows = beeper
      .query<BeeperRow, []>(BEEPER_SQL)
      .all()
      .flatMap((r) => {
        const network = networkOf(r.account);
        return network ? [{ ...r, network }] : [];
      });
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
        ...[r.id, r.eventId, r.chat, r.chatName, r.network],
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
