import { Database, type SQLQueryBindings } from "bun:sqlite";
import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { clock } from "./clock";
import { type LogEvent, log, recentEvents } from "./log";
import { codeAt, exec } from "./proc";
import { settings } from "./settings";
import { ARCHIVE, archiveDb, BEEPER, WHATSAPP } from "./sources/archived";
import { fromAppleS, toAppleS } from "./sources/imessage";
import { enabledSources, SOURCES } from "./sources/index";
import { listNotes, NOTES, noteVersion } from "./sources/notes";
import { ROOT } from "./truth";

// Keeps every message the Mac's WhatsApp app receives, and every LINE, Telegram and Instagram message Beeper Desktop
// holds, before a delete for everyone wipes it, and every version of each Apple Note, which Notes overwrites in place.
// The only copy of what an app wiped is one taken while it existed. The apps' stores are opened read-only; only the
// archive is written (whatsapp.sqlite, beeper.sqlite, notes.sqlite). Query the deleted ones with `archive deleted`.

const LOCAL = /^local-/;
// WhatsApp lets senders delete for everyone for about 60 hours; edits and late media downloads fit in a week too.
const WINDOW_S = 7 * 86_400;

interface Row {
  at: number;
  chat: string | null;
  chatName: string | null;
  fromMe: number;
  id: string;
  media: string;
  sender: string | null;
  senderName: string | null;
  text: string;
  type: number;
}

/** An archive store in `dir`, its tables created and its `deleted` view made again by `schema`. */
function openArchive(dir: string, name: string, schema: string) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(archiveDb(name, dir));
  db.run("pragma journal_mode = wal");
  db.run(schema);
  return db;
}

/** Inserts each row's values in one transaction (an `insert or ignore` skips versions already archived); how many were new. */
function insertAll(db: Database, sql: string, rows: SQLQueryBindings[][]) {
  const insert = db.prepare(sql);
  let added = 0;
  db.transaction(() => {
    for (const values of rows) {
      added += insert.run(...values).changes;
    }
  })();
  return added;
}

// One row per version a message was seen in: the original, each edit, and the "deleted" placeholder (type 14).
// A delete for everyone removes the original and adds a type-14 row with a new id but the original's time and sender.
const open = (dir: string) =>
  openArchive(
    dir,
    "whatsapp",
    `create table if not exists messages (
    id text not null, chat text, chatName text, sender text, senderName text, fromMe integer,
    at text not null, type integer not null, text text not null, media text not null, seenAt text not null,
    unique (chat, id, type, text, media));
  drop view if exists deleted;
  create view deleted as
    select m.*, d.seenAt as deletedSeenAt from messages m
      join messages d on d.chat is m.chat and d.at = m.at and d.fromMe = m.fromMe and d.type = 14
     where m.type <> 14 and (m.text <> '' or m.media <> '')`
  );

/** Copies new and changed messages (and their media) into the archive. Returns how many versions were new. */
export function archiveOnce(
  source = WHATSAPP,
  dir = ARCHIVE,
  now = clock().getTime()
): number {
  const archive = open(dir);
  const whatsapp = new Database(join(source, "ChatStorage.sqlite"), {
    readonly: true,
  });
  try {
    const empty = !archive.query("select 1 from messages limit 1").get();
    // The first run copies all history; later runs only the last week, where anything can still change.
    const since = empty ? 0 : toAppleS(now) - WINDOW_S;
    const rows = whatsapp
      .query<Row, [number]>(
        `select coalesce(m.ZSTANZAID, 'pk:' || m.Z_PK) as id, m.ZMESSAGETYPE as type, m.ZISFROMME as fromMe,
                m.ZMESSAGEDATE as at, coalesce(m.ZTEXT, '') as text, coalesce(i.ZMEDIALOCALPATH, '') as media,
                s.ZCONTACTJID as chat, s.ZPARTNERNAME as chatName,
                coalesce(g.ZMEMBERJID, m.ZFROMJID) as sender, g.ZCONTACTNAME as senderName
           from ZWAMESSAGE m
           left join ZWACHATSESSION s on s.Z_PK = m.ZCHATSESSION
           left join ZWAMEDIAITEM i on i.Z_PK = m.ZMEDIAITEM
           left join ZWAGROUPMEMBER g on g.Z_PK = m.ZGROUPMEMBER
          where m.ZMESSAGEDATE > ?`
      )
      .all(since);
    const seenAt = new Date(now).toISOString();
    const added = insertAll(
      archive,
      `insert or ignore into messages (id, chat, chatName, sender, senderName, fromMe, at, type, text, media, seenAt)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows.map((r) => [
        ...[r.id, r.chat, r.chatName, r.sender, r.senderName, r.fromMe],
        fromAppleS(r.at).toISOString(),
        ...[r.type, r.text, r.media, seenAt],
      ])
    );
    for (const { media } of rows) {
      const from = join(source, "Message", media);
      const to = join(dir, "media", media);
      if (media && !existsSync(to) && existsSync(from)) {
        mkdirSync(dirname(to), { recursive: true });
        // An APFS clone: no extra disk until WhatsApp deletes its copy.
        copyFileSync(from, to, constants.COPYFILE_FICLONE);
      }
    }
    return added;
  } finally {
    whatsapp.close();
    archive.close();
  }
}

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
export function archiveBeeperOnce(
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

// One row per version of a note Life saw: its text (checklist lines marked `[ ]`/`[x]`) and attachments' JSON, or its
// deletion (text and files empty). `at` is the note's edit time, or when Life saw it gone from the store. `deleted`
// is each deleted note's last version, named like a chat's (`chatName` its title).
const openNotes = (dir: string) =>
  openArchive(
    dir,
    "notes",
    `create table if not exists versions (
    note text not null, title text, folder text, shared integer not null, at text not null,
    text text not null, files text not null, deleted integer not null, seenAt text not null);
  create index if not exists versionsByNote on versions (note);
  drop view if exists deleted;
  create view deleted as
    select v.*, v.title as chatName, null as senderName, d.seenAt as deletedSeenAt
      from versions v join versions d on d.note = v.note and d.deleted = 1
     where v.rowid = (select max(rowid) from versions x where x.note = v.note and x.rowid < d.rowid) and v.deleted = 0`
  );

// A note edited in the last 2 minutes is still being typed: it is archived once quiet, so typing makes one version.
// ponytail: an edit purged ("Delete now") within those 2 minutes is lost; a shorter wait means more versions.
const QUIET_MS = 120_000;
// More notes than this gone at once is a sign-out or a rebuilt store, not deletions: none is marked.
const MASS_VANISH = 20;
// `<dir>\n<note>` -> the state already compared with its latest version, since a pin or a move changes the edit time
// and not the text.
const checked = new Map<string, string>();
const refused = new Set<string>();

interface Latest {
  at: string;
  deleted: number;
  folder: string | null;
  note: string;
  rowid: number;
  shared: number;
  title: string | null;
}

/** Deleted rows for the archived notes gone from the store; none when too many went at once (logged once). */
function goneRows(
  latest: Latest[],
  present: Set<string>,
  dir: string,
  seenAt: string
) {
  const gone = latest.filter((v) => !(v.deleted || present.has(v.note)));
  if (gone.length > MASS_VANISH || (gone.length > 0 && present.size === 0)) {
    if (!refused.has(dir)) {
      console.error(
        `${seenAt} notes: ${gone.length} gone from the store at once, none marked deleted`
      );
    }
    refused.add(dir);
    return [];
  }
  refused.delete(dir);
  return gone.map((v) => [
    ...[v.note, v.title, v.folder, v.shared, seenAt],
    ...["", "[]", 1, seenAt],
  ]);
}

/** Archives a new version of each note whose text, attachments or deleted state changed. Returns how many. */
export function archiveNotesOnce(
  source = NOTES,
  dir = ARCHIVE,
  now = clock().getTime()
): number {
  const path = join(source, "NoteStore.sqlite");
  if (!existsSync(path)) {
    return 0;
  }
  const archive = openNotes(dir);
  const store = new Database(path, { readonly: true });
  try {
    const latest = new Map(
      archive
        .query<Latest, []>(
          `select rowid, note, title, folder, shared, at, deleted from versions
            where rowid in (select max(rowid) from versions group by note)`
        )
        .all()
        .map((v) => [v.note, v])
    );
    const previous = archive.query<
      { deleted: number; files: string; text: string },
      [number]
    >("select text, files, deleted from versions where rowid = ?");
    const seenAt = new Date(now).toISOString();
    const notes = listNotes(store);
    const rows: SQLQueryBindings[][] = [];
    // ponytail: a note is compared again only when its edit time moves, so a change that leaves the time alone (Apple's
    // OCR of a photo finishing later) waits for the next edit.
    for (const n of notes) {
      const key = `${dir}\n${n.id}`;
      const last = latest.get(n.id);
      const stamp = `${last?.rowid} ${n.at} ${n.deleted}`;
      if (
        n.unreadable ||
        (last?.at === n.at && last.deleted === n.deleted) ||
        checked.get(key) === stamp ||
        now - Date.parse(n.at) < QUIET_MS
      ) {
        continue;
      }
      const row = (body: { files: string; text: string }, deleted: number) => [
        ...[n.id, n.title, n.folder, n.shared, n.at],
        ...[body.text, body.files, deleted, seenAt],
      ];
      // A note in Recently Deleted still has its text: its last edit is kept before the deleted row.
      const { files, text } = noteVersion(store, source, n.pk);
      const v = { files: JSON.stringify(files), text };
      const p = last && previous.get(last.rowid);
      if (
        !p ||
        (p.deleted ? !n.deleted : p.text !== v.text || p.files !== v.files)
      ) {
        rows.push(row(v, 0));
      }
      if (n.deleted && !p?.deleted) {
        rows.push(row({ files: "[]", text: "" }, 1));
      }
      checked.set(key, stamp);
    }
    rows.push(
      ...goneRows(
        [...latest.values()],
        new Set(notes.map((n) => n.id)),
        dir,
        seenAt
      )
    );
    return insertAll(
      archive,
      `insert into versions (note, title, folder, shared, at, text, files, deleted, seenAt)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows
    );
  } finally {
    store.close();
    archive.close();
  }
}

// Each store the archive keeps, on its own, so one app being closed or locked never stops the others. `app` writes it
// and is kept running: closed, it receives nothing (and Beeper's store cannot be opened read-only). `media` is the
// column of `deleted` that names a copied file; `copies` the table each copy is a row of.
export const STORES = [
  {
    app: "WhatsApp",
    copies: "messages",
    copy: archiveOnce,
    media: "media",
    name: "whatsapp",
  },
  {
    app: "Beeper Desktop",
    copies: "messages",
    copy: archiveBeeperOnce,
    media: "''",
    name: "beeper",
  },
  {
    app: "Notes",
    copies: "versions",
    copy: archiveNotesOnce,
    media: "''",
    name: "notes",
  },
];

/** The stores of the sources he turned on (the `sources` setting): no other app is copied or kept open. */
export const keptStores = (on = settings().sources) => {
  const names = new Set<string>(enabledSources(SOURCES, on).map((s) => s.name));
  return STORES.filter((s) => names.has(s.name));
};

/** When the archive last copied anything into a store (a new message or note version); null: none yet, or no store. */
export function lastCopied(store: (typeof STORES)[number], dir = ARCHIVE) {
  const path = archiveDb(store.name, dir);
  if (!existsSync(path)) {
    return null;
  }
  const db = new Database(path, { readonly: true });
  try {
    return (
      db
        .query<{ at: string | null }, []>(
          `select max(seenAt) as at from ${store.copies}`
        )
        .get()?.at ?? null
    );
  } finally {
    db.close();
  }
}

// An app opened less than 10 minutes ago is not opened again, so one that fails to start is not relaunched every pass.
const REOPEN_MS = 600_000;
const openedAt = new Map<string, number>();

/** The kept stores' apps to open: not among `running` (process names) and not opened in the last 10 minutes. */
export const appsToOpen = (
  running: string[],
  now: number,
  opened = openedAt,
  stores = keptStores()
) =>
  stores
    .map((s) => s.app)
    .filter(
      (app) =>
        !running.includes(app) && now - (opened.get(app) ?? 0) >= REOPEN_MS
    );

/**
 * Opens each store's app that is not running, hidden and in the background (`ps -c` names them as STORES does), each
 * `open` given 5 s at most, so a hung LaunchServices never holds up the copies.
 */
async function keepAppsOpen() {
  const now = clock().getTime();
  const running = (await exec(["ps", "-axco", "comm="])).stdout.split("\n");
  await Promise.all(
    appsToOpen(running, now).map(async (app) => {
      openedAt.set(app, now);
      const { code, stderr } = await exec(["open", "-g", "-j", "-a", app], {
        timeout: 5000,
      });
      console.log(
        `${new Date(now).toISOString()} opened ${app}${code ? `: failed, ${stderr.trim()}` : ""}`
      );
    })
  );
}

/** The deleted messages one store kept since `since`, opened read-only: the archive is their only copy. */
function deletedIn(name: string, media: string, since: string) {
  const path = archiveDb(name);
  if (!existsSync(path)) {
    return [];
  }
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<
        {
          at: string;
          chatName: string | null;
          media: string;
          senderName: string | null;
          text: string;
        },
        [string]
      >(
        `select at, chatName, senderName, text, ${media} as media from deleted where deletedSeenAt > ?`
      )
      .all(since);
  } finally {
    db.close();
  }
}

function printDeleted(days: number) {
  const since = new Date(clock().getTime() - days * 864e5).toISOString();
  const rows = STORES.flatMap((s) => deletedIn(s.name, s.media, since)).sort(
    (a, b) => a.at.localeCompare(b.at)
  );
  for (const r of rows) {
    const media = r.media ? ` [${join(ARCHIVE, "media", r.media)}]` : "";
    console.log(
      `${r.at}  ${r.chatName ?? "?"}${r.senderName ? ` · ${r.senderName}` : ""}: ${r.text.replaceAll("\n", " ")}${media}`
    );
  }
}

// A store failing since its first failed pass until its next good one is an incident, logged at both ends
// (`archive.<store>`: run.error, run.end). The log is its only record: read back on a restart (each commit), by the
// night's line, and by the nightly tick that emails him an hour in (18 Oct: Beeper's store would not open for 5 hours,
// unseen, and what is deleted meanwhile is lost).

// ponytail: an incident open over 7 days drops out of the window until the archive restarts and logs it again.
export const ARCHIVE_LOOKBACK = 7;

/** The incidents open at the end of `lines` (run events, oldest first): each store's first failed pass. */
export function openIncidents(lines: LogEvent[]) {
  const started = new Map<string, LogEvent>();
  for (const e of lines.filter((l) => l.step.startsWith("archive."))) {
    const name = e.step.slice("archive.".length);
    if (e.kind === "run.error") {
      started.set(name, e);
    } else {
      started.delete(name);
    }
  }
  return started;
}

/** The stores failing for at least `ms` at `now`, by store, from the last 7 days of derived/log. */
export async function archiveFailing(ms = 0, now = clock().getTime()) {
  const kept = new Set(keptStores().map((s) => s.name as string));
  // A store he turned off since has no incident: it is no longer copied, so nothing would ever close it.
  return [...openIncidents(await recentEvents(ARCHIVE_LOOKBACK))].filter(
    ([name, e]) => kept.has(name) && now - Date.parse(e.at) >= ms
  );
}

/**
 * `archive` runs until a commit changes the code (the LaunchAgent starts it again), `archive --once` once,
 * `archive deleted [days]` prints deleted messages.
 */
export async function archiveCommand(args: string[]): Promise<number> {
  if (args[0] === "deleted") {
    printDeleted(Number(args[1] ?? 7));
    return 0;
  }
  const running = codeAt(ROOT);
  const failing = new Set((await archiveFailing()).map(([name]) => name));
  while (codeAt(ROOT) === running) {
    for (const { copy, name } of keptStores()) {
      try {
        const added = copy();
        if (failing.delete(name)) {
          log("run.end", { step: `archive.${name}` });
        }
        if (added > 0) {
          console.log(`${clock().toISOString()} archived ${added} ${name}`);
        }
      } catch (error) {
        console.error(clock().toISOString(), name, error);
        if (!failing.has(name)) {
          failing.add(name);
          log("run.error", {
            error: (error as Error).message,
            step: `archive.${name}`,
          });
        }
      }
    }
    if (args.includes("--once")) {
      return 0;
    }
    // ponytail: 5 s poll; a message sent and deleted within one tick is missed. Watch the WAL file if that matters.
    // biome-ignore lint/performance/noAwaitInLoops: sequential poll loop
    await Promise.all([keepAppsOpen(), Bun.sleep(5000)]);
  }
  console.log(`${clock().toISOString()} new code: restarting`);
  return 0;
}
