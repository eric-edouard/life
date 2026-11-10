import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceName } from "../core/names";
import {
  copierOf,
  copyBeeper,
  copyBridged,
  localpartOf,
  NETWORKS,
  openBridged,
  readBridged,
} from "./bridged";
import { BRIDGES } from "./matrix";

const BOT = "@linebot:life.local";
const ANA = "@line_u1:life.local";
const ME = "@line_u_me:life.local";
const ROOM = "!r1:life.local";

/** A made-up homeserver and LINE bridge: Ana and him in one room, the bridge's bot joined. */
function stores() {
  const dir = join(BRIDGES, "line");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.yaml"),
    "appservice:\n  bot:\n    username: linebot\n  username_template: line_{{.}}\n"
  );
  const bridge = new Database(join(dir, "line.db"));
  bridge.run("create table if not exists user_login (id text)");
  bridge.run("delete from user_login");
  bridge.run("insert into user_login values ('uMe')");
  bridge.close();
  const synapse = join(
    mkdtempSync(join(tmpdir(), "synapse-")),
    "homeserver.db"
  );
  const hs = new Database(synapse);
  hs.run(`create table events (stream_ordering integer primary key, event_id text, room_id text, type text,
    sender text, origin_server_ts integer, rejection_reason text, outlier integer default 0)`);
  hs.run("create table event_json (event_id text, json text)");
  hs.run(`create table room_memberships (room_id text, user_id text, membership text, display_name text,
    event_stream_ordering integer)`);
  hs.run(
    "create table current_state_events (event_id text, room_id text, type text)"
  );
  for (const [user, name] of [
    [BOT, "LINE bridge bot"],
    [ANA, "Ana"],
    [ME, "Me"],
  ] as const) {
    hs.run("insert into room_memberships values (?, ?, 'join', ?, 1)", [
      ROOM,
      user,
      name,
    ]);
  }
  let n = 0;
  const event = (
    type: string,
    sender: string,
    content: object,
    extra: object = {}
  ) => {
    n += 1;
    const id = `$e${n}`;
    hs.run("insert into events values (?, ?, ?, ?, ?, ?, null, 0)", [
      n,
      id,
      ROOM,
      type,
      sender,
      1_800_000_000_000 + n * 1000,
    ]);
    hs.run("insert into event_json values (?, ?)", [
      id,
      JSON.stringify({ content, ...extra }),
    ]);
    return id;
  };
  return { event, hs, synapse };
}

test("a bridged chat keeps every version: the message, its edit, its deletion with the text, his own, a file", () => {
  const { event, synapse } = stores();
  const archive = mkdtempSync(join(tmpdir(), "archive-"));
  const hi = event("m.room.message", ANA, {
    body: "see you at 8",
    msgtype: "m.text",
  });
  event("m.room.message", ANA, {
    body: "* see you at 9",
    "m.new_content": { body: "see you at 9" },
    "m.relates_to": { event_id: hi, rel_type: "m.replace" },
    msgtype: "m.text",
  });
  event("m.room.message", ME, { body: "ok", msgtype: "m.text" });
  const photo = event("m.room.message", ANA, {
    body: "a.jpg",
    info: { mimetype: "image/jpeg" },
    msgtype: "m.image",
    url: "mxc://life.local/abcdefgh",
  });
  event("m.room.message", BOT, { body: "Connected", msgtype: "m.notice" });
  // A reaction removed: never a deletion of anything.
  const like = event("m.reaction", ANA, {});
  event("m.room.redaction", ANA, {}, { redacts: like });
  event("m.room.redaction", ANA, {}, { redacts: photo });

  expect(copyBridged("line", archive, Date.now(), synapse)).toBeGreaterThan(0);
  expect(copyBridged("line", archive, Date.now(), synapse)).toBe(0);
  // A new message later: only it is copied.
  event("m.room.message", ANA, { body: "here", msgtype: "m.text" });
  expect(copyBridged("line", archive, Date.now(), synapse)).toBe(1);

  const read = readBridged(NETWORKS[0], new Date(0), archive);
  expect(
    read.map((e) => [e.text, e.fromMe, e.sender, e.deleted ?? false])
  ).toEqual([
    ["see you at 9", false, "u1", false],
    ["ok", true, "me", false],
    ["a.jpg", false, "u1", true],
    ["here", false, "u1", false],
  ]);
  expect(read[0]?.chatName).toBe("Ana");
  expect(read[2]?.files?.[0]?.mime).toBe("image/jpeg");
  const deleted = new Database(join(archive, "line.sqlite"))
    .query<{ text: string }, []>("select text from deleted")
    .all();
  expect(deleted).toEqual([{ text: "a.jpg" }]);
});

test("a login id becomes the localpart the bridge writes for it", () => {
  expect(localpartOf("uMe")).toBe("u_me");
  expect(localpartOf("a_b c")).toBe("a__b=20c");
});

test("a network's call notices are phone calls: a start takes its length from its end, which goes", () => {
  const { event, synapse } = stores();
  const archive = mkdtempSync(join(tmpdir(), "archive-"));
  const notice = (body: string) =>
    event("m.room.message", ANA, { body, msgtype: "m.notice" });
  notice("ana started an audio call");
  event("m.room.message", ANA, { body: "can you hear me", msgtype: "m.text" });
  notice("Audio call ended");
  notice("You missed a video chat");
  // A start then "You missed": one call, not picked up. A start with no end or miss has no length.
  notice("ana started a video chat");
  notice("You missed a video chat");
  notice("ana started an audio call");
  // Typed by a person, not the bridge: words, never a call.
  event("m.room.message", ANA, { body: "Audio call ended", msgtype: "m.text" });
  copyBridged("line", archive, Date.now(), synapse);

  const [line, instagram] = NETWORKS;
  // This made-up homeserver bridges LINE; Instagram's notices read through its own `callOf`.
  const read = readBridged(
    { ...line, callOf: instagram.callOf },
    new Date(0),
    archive
  );
  expect(read.map((e) => [e.text, e.phoneCall])).toEqual([
    ["ana started an audio call", { seconds: 2, video: false }],
    ["can you hear me", undefined],
    ["You missed a video chat", { seconds: 0, video: true }],
    ["ana started a video chat", { seconds: 0, video: true }],
    ["ana started an audio call", { video: false }],
    ["Audio call ended", undefined],
  ]);
  expect(line.callOf("Voice call (1h2m3s)")).toEqual({
    seconds: 3723,
    video: false,
  });
  expect(line.callOf("Missed video call")).toEqual({ seconds: 0, video: true });
  expect(line.callOf("Voice call")).toBeUndefined();
});

test("every bridged network is a stored source name", () => {
  for (const { name } of NETWORKS) {
    expect(SourceName.options).toContain(name);
  }
});

/** A made-up Beeper Desktop store: one chat with Ana on `account`, `messages` as [id, ms, text, deleted]. */
function beeperStore(
  messages: [number, number, string, number][],
  account = "line.u0"
) {
  const dir = mkdtempSync(join(tmpdir(), "beeper-"));
  const db = new Database(join(dir, "index.db"));
  db.run("create table threads (threadID text, accountID text, thread text)");
  db.run(
    "create table participants (room_id text, id text, full_name text, is_self integer)"
  );
  db.run(`create table mx_room_messages (id integer, eventID text, roomID text, senderContactID text,
    isSentByMe integer, timestamp integer, type text, message text, isDeleted integer)`);
  db.run("insert into threads values ('!b1:beeper.local', ?, '{}')", [account]);
  db.run(
    `insert into participants values ('!b1:beeper.local', '@ana:beeper.local', 'Ana', 0)`
  );
  for (const [id, ms, text, deleted] of messages) {
    db.run(
      "insert into mx_room_messages values (?, ?, '!b1:beeper.local', '@ana:beeper.local', 0, ?, 'TEXT', ?, ?)",
      [id, `$e${id}`, ms, JSON.stringify({ text }), deleted]
    );
  }
  db.close();
  return dir;
}

test("LINE without its bridge is copied from Beeper: only after the bridge's newest message, every version kept", () => {
  const archive = mkdtempSync(join(tmpdir(), "archive-"));
  const db = openBridged("line", archive);
  // The bridge copied one message at 10:00 (its room is the homeserver's); Beeper also holds an earlier one, from the
  // bridge's time. A later chat Beeper no longer holds was Beeper's, not the bridge's: it moves nothing.
  db.run(`insert into messages (id, eventId, chat, fromMe, at, type, text, deleted, seenAt)
    values (1, '$x', '!r1', 0, '2026-11-05T10:00:00.000Z', 'm.text', 'from the bridge', 0, '2026-11-05T10:00:01.000Z')`);
  db.run(`insert into messages (id, eventId, chat, fromMe, at, type, text, deleted, seenAt)
    values (9, '$y', '!gone:beeper.local', 0, '2026-11-05T12:00:00.000Z', 'TEXT', 'a chat Beeper dropped', 0, '2026-11-05T12:00:01.000Z')`);
  db.close();
  const synapse = join(
    mkdtempSync(join(tmpdir(), "synapse-")),
    "homeserver.db"
  );
  const hs = new Database(synapse);
  hs.run("create table rooms (room_id text)");
  hs.run("insert into rooms values ('!r1')");
  hs.close();
  const at = (hh: number) => Date.parse(`2026-11-05T${hh}:00:00.000Z`);
  const beeper = beeperStore([
    [1, at(9), "Beeper's copy of the bridge's time", 0],
    [2, at(11), "the heater is in", 0],
  ]);
  expect(copierOf("telegram", beeper)).toBeUndefined();
  expect(copierOf("telegram", beeperStore([], "local-telegram_u0"))).toBe(
    "beeper"
  );
  const copy = () => copyBeeper("line", archive, beeper, Date.now(), synapse);
  expect(copy()).toBe(1);
  expect(copy()).toBe(0);
  // Ana edits, then deletes it: each a version.
  const store = new Database(join(beeper, "index.db"));
  store.run(
    `update mx_room_messages set message = '{"text":"the heater is in now"}' where id = 2`
  );
  expect(copy()).toBe(1);
  store.run(
    "update mx_room_messages set message = '{}', isDeleted = 1 where id = 2"
  );
  store.close();
  expect(copy()).toBe(1);

  const read = readBridged(NETWORKS[0], new Date(0), archive);
  expect(read.map((e) => [e.text, e.chatName, e.deleted ?? false])).toEqual([
    ["from the bridge", undefined, false],
    ["the heater is in now", "Ana", true],
    ["a chat Beeper dropped", undefined, false],
  ]);
});

test("Beeper closed: its store can't be read, so the archive opens Beeper and the copy fails until it can", () => {
  // A closed Beeper leaves a WAL store with no `-shm`: macOS's SQLite refuses to open it read-only.
  const closed = beeperStore(
    [[1, Date.now(), "the heater is in", 0]],
    "local-telegram_u0"
  );
  const store = new Database(join(closed, "index.db"));
  store.run("pragma journal_mode = wal");
  store.close();
  expect(copierOf("telegram", closed)).toBe("beeper-closed");
  const archive = mkdtempSync(join(tmpdir(), "archive-"));
  const copy = () => copyBeeper("telegram", archive, closed);
  // The archive's incident for the store stays open until a copy reads it again.
  expect(copy).toThrow("Beeper is closed");
  // Beeper runs again: its store has its `-shm`.
  const running = new Database(join(closed, "index.db"));
  running.query("select 1 from threads").get();
  expect(copierOf("telegram", closed)).toBe("beeper");
  expect(copy()).toBe(1);
  running.close();
});
