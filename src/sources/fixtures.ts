import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { APPLE_EPOCH_S, toAppleNs } from "./imessage";
import { openStore } from "./lifelog";

// Small stores to test the readers against: lifelog's change feed, and the Mac apps' databases the archive copies.

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** An empty lifelog store in a fresh folder. */
export const lifelogStore = () => openStore(tmp("life-lifelog-"));

/** A page of lifelog's change feed. */
export const page = (over: Record<string, unknown> = {}) => ({
  chapters: [],
  conversations: [],
  cursor: "1",
  more: false,
  removed: [],
  turns: [],
  ...over,
});

export const conversation = (
  id: string,
  over: Record<string, unknown> = {}
) => ({
  endAt: "2026-10-14T10:10:00.000Z",
  id,
  kind: "conversation",
  ownerTitle: null,
  retired: null,
  startAt: "2026-10-14T10:00:00.000Z",
  state: "summarized",
  title: "The plumber",
  ...over,
});

export const turn = (
  turnIndex: number,
  startAt: string,
  personId: string | null,
  personName: string | null,
  conversationId: string | null = "c1",
  isOwner = false
) => ({
  conversationId,
  jobId: "job-1",
  speaker: { isOwner, personId, personName },
  startAt,
  turnIndex,
});

export const chapter = (id: string, startAt: string, endAt: string) => ({
  conversationId: "c1",
  endAt,
  id,
  startAt,
  summary: `Summary of ${id}`,
  title: id,
});

/** WhatsApp's own store (one chat, `120@g.us` "Team", one group member `777@lid`) and the archive folder beside it. */
export function whatsappFixture() {
  const source = tmp("wa-");
  const dir = tmp("archive-");
  const wa = new Database(join(source, "ChatStorage.sqlite"));
  wa.run(`create table ZWAMESSAGE (Z_PK integer, ZSTANZAID text, ZMESSAGETYPE integer, ZISFROMME integer,
    ZMESSAGEDATE real, ZTEXT text, ZMEDIAITEM integer, ZCHATSESSION integer, ZGROUPMEMBER integer,
    ZFROMJID text, ZPUSHNAME text)`);
  wa.run(
    "create table ZWACHATSESSION (Z_PK integer, ZCONTACTJID text, ZPARTNERNAME text)"
  );
  wa.run("create table ZWAMEDIAITEM (Z_PK integer, ZMEDIALOCALPATH text)");
  wa.run(
    "create table ZWAGROUPMEMBER (Z_PK integer, ZMEMBERJID text, ZCONTACTNAME text)"
  );
  wa.run(
    "insert into ZWACHATSESSION values (1, '120@g.us', '\u202aTeam\u202c')"
  );
  wa.run("insert into ZWAGROUPMEMBER values (1, '777@lid', null)");
  const contacts = new Database(join(source, "ContactsV2.sqlite"));
  contacts.run(
    "create table ZWAADDRESSBOOKCONTACT (ZLID text, ZPHONENUMBER text)"
  );
  contacts.run(
    "insert into ZWAADDRESSBOOKCONTACT values ('777@lid', '+66 60 000 0001')"
  );
  const now = Date.now();
  /** A message `agoS` seconds before `now`, with a file in WhatsApp's store at `media` (under Message/). */
  const add = (
    pk: number,
    id: string,
    type: number,
    text: string | null,
    agoS = 60,
    media?: string
  ) => {
    if (media) {
      mkdirSync(join(source, "Message", dirname(media)), { recursive: true });
      writeFileSync(join(source, "Message", media), "bytes");
      wa.run("insert into ZWAMEDIAITEM values (?, ?)", [pk, media]);
    }
    wa.run(
      "insert into ZWAMESSAGE values (?, ?, ?, 0, ?, ?, ?, 1, 1, '120@g.us', null)",
      [pk, id, type, now / 1000 - 978_307_200 - agoS, text, media ? pk : null]
    );
  };
  return { add, dir, now, source, wa };
}

/** Beeper's index.db (a Telegram chat `!tg` with Ana, a WhatsApp one) with the Telegram bridge, and the archive folder. */
export function beeperFixture() {
  const source = tmp("beeper-");
  const dir = tmp("archive-");
  const index = new Database(join(source, "index.db"));
  index.run(`create table mx_room_messages (id integer primary key, roomID text, eventID text, senderContactID text,
    timestamp integer, isDeleted integer, isSentByMe integer, type text, message text)`);
  index.run(
    "create table threads (threadID text, accountID text, thread text)"
  );
  index.run(
    "create table participants (room_id text, id text, full_name text, is_self integer)"
  );
  index.run(
    "insert into threads values ('!tg', 'local-telegram_x', '{}'), ('!wa', 'whatsapp', '{}')"
  );
  index.run("insert into participants values ('!tg', '@ana:tg', 'Ana', 0)");
  const bridge = join(source, "local-telegram");
  mkdirSync(bridge);
  const ghosts = new Database(join(bridge, "megabridge.db"));
  ghosts.run("create table ghost (bridge_id text, id text, identifiers text)");
  ghosts.run(
    "create table message (bridge_id text, sender_id text, sender_mxid text)"
  );
  ghosts.run(
    "insert into ghost values ('b', '7', '[\"tel:+66 60 000 0001\"]')"
  );
  ghosts.run("insert into message values ('b', '7', '@ana:tg')");
  const now = Date.now();
  const add = (
    id: number,
    room: string,
    type: string,
    text: string,
    attachments: unknown[] = []
  ) =>
    index.run(
      "insert into mx_room_messages values (?, ?, ?, '@ana:tg', ?, 0, 0, ?, ?)",
      [
        id,
        room,
        `$e${id}`,
        now - 60_000,
        type,
        JSON.stringify({ attachments, text }),
      ]
    );
  return { add, dir, index, now, source };
}

const varint = (n: number): number[] =>
  n < 128 ? [n] : [(n % 128) + 128, ...varint(Math.floor(n / 128))];

/** A protobuf message of `[field, number | string | bytes]` pairs. */
const proto = (
  ...fields: (readonly [number, number | string | Uint8Array])[]
) =>
  Uint8Array.from(
    fields.flatMap(([n, v]) => {
      if (typeof v === "number") {
        return [...varint(n * 8), ...varint(v)];
      }
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
      return [...varint(n * 8 + 2), ...varint(bytes.length), ...bytes];
    })
  );

/** An attribute run of a note body: `length` UTF-16 units, a checklist item (done or not), or an attachment. */
export const run = (
  length: number,
  { attachment, done }: { attachment?: string; done?: number } = {}
) =>
  proto(
    [1, length],
    ...(done === undefined
      ? []
      : ([[2, proto([1, 103], [5, proto([1, "uuid"], [2, done])])]] as const)),
    ...(attachment ? ([[12, proto([1, attachment])]] as const) : [])
  );

/** A note body as Notes stores it: gzip (zlib before 2019) of document (2) → note (3) → text (2) and runs (5). */
export const noteData = (
  text: string,
  runs: Uint8Array[] = [],
  zip: (data: Uint8Array) => Uint8Array = gzipSync
) =>
  zip(
    proto([
      2,
      proto([3, proto([2, text], ...runs.map((r) => [5, r] as const))]),
    ])
  );

/**
 * Apple Notes' store (folders Notes and Recently Deleted, one account) and the archive folder beside it. `save` writes
 * note `N<pk>`, edited `agoS` seconds before `now`.
 */
export function notesFixture() {
  const source = tmp("notes-");
  const dir = tmp("archive-");
  const db = new Database(join(source, "NoteStore.sqlite"));
  db.run("create table Z_PRIMARYKEY (Z_ENT integer, Z_NAME text)");
  db.run(
    "insert into Z_PRIMARYKEY values (5, 'ICAttachment'), (11, 'ICMedia'), (12, 'ICNote'), (14, 'ICAccount'), (15, 'ICFolder')"
  );
  db.run(`create table ZICCLOUDSYNCINGOBJECT (Z_PK integer primary key, Z_ENT integer, ZIDENTIFIER text, ZTITLE1 text,
    ZTITLE2 text, ZFOLDER integer, ZFOLDERTYPE integer, ZSERVERSHAREDATA blob, ZMODIFICATIONDATE1 real,
    ZMARKEDFORDELETION integer, ZISPASSWORDPROTECTED integer, ZNEEDSINITIALFETCHFROMCLOUD integer, ZTYPEUTI text,
    ZFILENAME text, ZGENERATION1 text, ZMEDIA integer, ZACCOUNT6 integer, ZPARENTATTACHMENT integer,
    ZOCRSUMMARY text, ZSUMMARY text)`);
  db.run("create table ZICNOTEDATA (ZNOTE integer, ZDATA blob)");
  db.run(`insert into ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZFOLDERTYPE) values
    (101, 15, 'F1', 'Notes', 0), (102, 15, 'F2', 'Recently Deleted', 1), (103, 14, 'ACC', null, null)`);
  const now = Date.now();
  const save = (
    pk: number,
    data: Uint8Array | null,
    {
      agoS = 600,
      binned = false,
      locked = 0,
      shared = false,
    }: {
      agoS?: number;
      binned?: boolean;
      locked?: number;
      shared?: boolean;
    } = {}
  ) => {
    db.run(
      `insert or replace into ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZSERVERSHAREDATA,
         ZMODIFICATIONDATE1, ZMARKEDFORDELETION, ZISPASSWORDPROTECTED, ZNEEDSINITIALFETCHFROMCLOUD)
       values (?, 12, ?, ?, ?, ?, ?, 0, ?, 0)`,
      [
        ...[
          pk,
          `N${pk}`,
          `Note ${pk}`,
          binned ? 102 : 101,
          shared ? "share" : null,
        ],
        ...[now / 1000 - APPLE_EPOCH_S - agoS, locked],
      ]
    );
    db.run("delete from ZICNOTEDATA where ZNOTE = ?", [pk]);
    db.run("insert into ZICNOTEDATA values (?, ?)", [pk, data]);
  };
  return { db, dir, now, save, source };
}

/**
 * chat.db with one message from +33611111111 a minute ago, and the files it carries: `path` is where Messages keeps
 * one (`~/` for the home folder), none when it was never downloaded.
 */
export function imessageFixture(
  text: string | null = "salut",
  files: { mime: string | null; name: string; path: string | null }[] = []
) {
  const path = join(tmp("imessage-"), "chat.db");
  const db = new Database(path);
  db.run(`create table message (ROWID integer primary key, guid text, date integer, is_from_me integer, text text,
    attributedBody blob, handle_id integer, item_type integer)`);
  db.run("create table handle (ROWID integer primary key, id text)");
  db.run(
    "create table chat (ROWID integer primary key, chat_identifier text, display_name text)"
  );
  db.run(
    "create table chat_message_join (chat_id integer, message_id integer)"
  );
  db.run(`create table attachment (ROWID integer primary key, guid text, filename text, mime_type text,
    transfer_name text, hide_attachment integer)`);
  db.run(
    "create table message_attachment_join (message_id integer, attachment_id integer)"
  );
  db.run("insert into handle values (1, '+33611111111')");
  db.run("insert into chat values (1, '+33611111111', null)");
  db.run("insert into message values (1, 'g1', ?, 0, ?, null, 1, 0)", [
    toAppleNs(new Date(Date.now() - 60_000)),
    text,
  ]);
  db.run("insert into chat_message_join values (1, 1)");
  for (const [i, f] of files.entries()) {
    db.run("insert into attachment values (?, ?, ?, ?, ?, 0)", [
      i + 1,
      `at_${i}`,
      f.path,
      f.mime,
      f.name,
    ]);
    db.run("insert into message_attachment_join values (1, ?)", [i + 1]);
  }
  // A link preview: never a file of the message.
  db.run(
    "insert into attachment values (99, 'preview', null, null, 'x.pluginPayloadAttachment', 1)"
  );
  db.run("insert into message_attachment_join values (1, 99)");
  return path;
}

/**
 * A stand-in for lifelog's REST API: `routes` map a path to what it answers (given the POSTed body). LIFELOG_URL and
 * LIFELOG_TOKEN point at it until `close`. `seen` records each request.
 */
export function lifelogServer(
  routes: Record<string, (body: unknown) => unknown>
) {
  const seen: { auth: string | null; body: unknown; path: string }[] = [];
  const server = Bun.serve({
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "POST" ? await req.json() : undefined;
      seen.push({ auth: req.headers.get("authorization"), body, path });
      const route = routes[path];
      return route
        ? Response.json(route(body))
        : new Response("", { status: 404 });
    },
    port: 0,
  });
  const before = {
    LIFELOG_TOKEN: process.env.LIFELOG_TOKEN,
    LIFELOG_URL: process.env.LIFELOG_URL,
  };
  process.env.LIFELOG_URL = `http://localhost:${server.port}`;
  process.env.LIFELOG_TOKEN = "test-token";
  return {
    close() {
      server.stop(true);
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
    seen,
  };
}
