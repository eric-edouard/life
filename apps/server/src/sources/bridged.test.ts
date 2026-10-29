import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBridged, localpartOf, readBridged } from "./bridged";
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
    sender text, origin_server_ts integer)`);
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
    hs.run("insert into events values (?, ?, ?, ?, ?, ?)", [
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

  const read = readBridged("line", new Date(0), archive);
  expect(
    read.map((e) => [e.text, e.fromMe, e.sender, e.deleted ?? false])
  ).toEqual([
    ["see you at 9", false, "u1", false],
    ["ok", true, "me", false],
    ["a.jpg", false, "u1", true],
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
