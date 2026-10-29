import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observationId } from "../memory/observe";
import { unitId } from "../memory/units";
import { ARCHIVE, matrixArchive } from "../sources/archived";
import { openBridged, readBridged } from "../sources/bridged";
import { beeperNetworks, importBeeper } from "./beeper-import";
import { migrateStored, renameStored } from "./migrate";

// Made-up memory written while Beeper read LINE: a chat-day unit, an observation from it, cited across the files.
const chat = "!ana:beeper.local";
const date = "2026-10-20";
const oldUnit = unitId("beeper", chat, date);
const newUnit = unitId("line", chat, date);
const quote = "see you at 8";
const text = "Ana meets the owner at 8";
const oldObs = observationId(oldUnit, "event", quote, text);
const newObs = observationId(newUnit, "event", quote, text);
const nets = {
  chats: new Map([[chat, "line"]]),
  files: new Map([["mxc://local/abc", "line"]]),
};

test("every stored Beeper name becomes its network's: source, refs, file refs, unit and observation ids", () => {
  const files = new Map([
    [
      "memory/units/2026-10-20.jsonl",
      JSON.stringify({
        date,
        hash: "h1",
        id: oldUnit,
        key: chat,
        refs: [`beeper:${chat}/1`, `beeper:${chat}/2`],
        source: "beeper",
        title: "beeper words kept",
      }),
    ],
    [
      "memory/observations/2026-10.jsonl",
      JSON.stringify({
        id: oldObs,
        quote,
        source: { channel: "beeper", ref: `beeper:${chat}/1` },
        text,
        type: "event",
        unit: oldUnit,
      }),
    ],
    [
      "memory/files.jsonl",
      JSON.stringify({
        hash: "f1",
        ref: "beeper:mxc://local/abc",
        what: "a beeper photo",
      }),
    ],
    [
      "memory/extracted.jsonl",
      JSON.stringify({ hash: "h1", observations: [oldObs], unit: oldUnit }),
    ],
    [
      "memory/whatsapp.jsonl",
      JSON.stringify({ source: "whatsapp", unit: "unit_000000000000" }),
    ],
  ]);
  const out = renameStored(files, nets).files;
  const unit = JSON.parse(out.get("memory/units/2026-10-20.jsonl") ?? "{}");
  expect(unit).toMatchObject({
    // The chat id keeps "beeper" in it: an id, never renamed.
    hash: "h1",
    id: newUnit,
    key: chat,
    refs: [`line:${chat}/1`, `line:${chat}/2`],
    source: "line",
    title: "beeper words kept",
  });
  expect(
    JSON.parse(out.get("memory/observations/2026-10.jsonl") ?? "{}")
  ).toMatchObject({
    id: newObs,
    source: { channel: "line", ref: `line:${chat}/1` },
    unit: newUnit,
  });
  expect(JSON.parse(out.get("memory/files.jsonl") ?? "{}")).toEqual({
    hash: "f1",
    ref: "line:mxc://local/abc",
    what: "a beeper photo",
  });
  // The model's cache follows the new ids, its hash kept: nothing is read again.
  expect(JSON.parse(out.get("memory/extracted.jsonl") ?? "{}")).toEqual({
    hash: "h1",
    observations: [newObs],
    unit: newUnit,
  });
  expect(out.has("memory/whatsapp.jsonl")).toBe(false);
});

test("a ref Beeper's archive doesn't know stops the rename instead of guessing", () => {
  const files = new Map([
    [
      "memory/files.jsonl",
      JSON.stringify({ ref: "beeper:mxc://local/unknown" }),
    ],
  ]);
  expect(() => renameStored(files, nets)).toThrow("Beeper's archive");
});

test("Beeper's messages join the network's archive once, from before its cutover, seen when Beeper saw them", () => {
  const archive = mkdtempSync(join(tmpdir(), "archive-"));
  const beeper = new Database(join(archive, "beeper.sqlite"));
  beeper.run(matrixArchive("network text not null,"));
  const row = (
    id: number,
    network: string,
    at: string,
    seenAt: string,
    sender: string
  ) =>
    beeper.run(
      `insert into messages (id, eventId, chat, chatName, network, sender, senderName, fromMe, at, type, text, deleted, seenAt)
       values (?, ?, ?, 'Ana', ?, ?, 'Ana', 0, ?, 'TEXT', ?, 0, ?)`,
      [id, `$e${id}`, `!${network}`, network, sender, at, `m${id}`, seenAt]
    );
  row(1, "line", "2026-10-20T08:00:00.000Z", "2026-10-20T08:00:05.000Z", "ana");
  // Seen after the bridge began: the bridge has it.
  row(2, "line", "2026-10-29T18:00:00.000Z", "2026-10-29T18:00:05.000Z", "ana");
  row(
    3,
    "telegram",
    "2026-10-21T08:00:00.000Z",
    "2026-10-21T08:00:05.000Z",
    "@tg_1:beeper.local"
  );
  beeper.close();
  const line = openBridged("line", archive);
  line.run(
    `insert into messages (id, eventId, chat, chatName, sender, senderName, fromMe, at, type, text, deleted, seenAt)
     values (9, '$b9', '!room', 'Ana', 'u1', 'Ana', 0, '2026-10-29T17:00:00.000Z', 'm.text', 'hi', 0, '2026-10-29T17:00:01.000Z')`
  );
  line.close();
  const beeperDir = mkdtempSync(join(tmpdir(), "beeper-"));
  mkdirSync(join(beeperDir, "local-telegram"));
  const bridge = new Database(
    join(beeperDir, "local-telegram", "megabridge.db")
  );
  bridge.run(
    "create table message (bridge_id text, sender_id text, sender_mxid text)"
  );
  bridge.run("create table ghost (bridge_id text, id text, identifiers text)");
  bridge.run("insert into message values ('tg', '1', '@tg_1:beeper.local')");
  bridge.run(`insert into ghost values ('tg', '1', '["tel:+15550100"]')`);
  bridge.close();
  writeFileSync(join(beeperDir, "index.db"), "");

  expect(importBeeper(archive, beeperDir)).toBe(2);
  expect(importBeeper(archive, beeperDir)).toBe(0);
  const lineRows = new Database(join(archive, "line.sqlite"))
    .query<{ seenAt: string; text: string }, []>(
      "select text, seenAt from messages order by at"
    )
    .all();
  expect(lineRows).toEqual([
    { seenAt: "2026-10-20T08:00:05.000Z", text: "m1" },
    { seenAt: "2026-10-29T17:00:01.000Z", text: "hi" },
  ]);
  expect(
    new Database(join(archive, "telegram.sqlite"))
      .query<{ sender: string }, []>("select sender from messages")
      .all()
  ).toEqual([{ sender: "+15550100" }]);
});

// Regression case audit-6-line-account-id: Beeper names an account `line.<id>`, `local-telegram_<id>` or
// `local-instagram_<id>`; each is its network, never the whole id.
test("Beeper's index names each chat's network by its account, in any of Beeper's forms", () => {
  const archive = mkdtempSync(join(tmpdir(), "archive-"));
  const beeperDir = mkdtempSync(join(tmpdir(), "beeper-"));
  const index = new Database(join(beeperDir, "index.db"));
  index.run("create table threads (threadID text, accountID text)");
  index.run(
    `insert into threads values ('!a', 'line.Uabc123'), ('!b', 'local-telegram_ba_x'), ('!c', 'local-instagram_ba_y'),
      ('!d', 'whatsapp.33600000000'), ('!e', 'hungryserv')`
  );
  index.close();
  expect(Object.fromEntries(beeperNetworks(archive, beeperDir).chats)).toEqual({
    "!a": "line",
    "!b": "telegram",
    "!c": "instagram",
    "!d": "whatsapp",
  });
});

test("a run on a copy of his memory never writes the live archive", async () => {
  const data = mkdtempSync(join(tmpdir(), "data-"));
  mkdirSync(join(data, "memory"));
  writeFileSync(join(data, "memory", "units.jsonl"), "");
  mkdirSync(ARCHIVE, { recursive: true });
  const beeper = new Database(join(ARCHIVE, "beeper.sqlite"));
  beeper.run(matrixArchive("network text not null,"));
  beeper.run(
    `insert into messages (id, eventId, chat, chatName, network, sender, senderName, fromMe, at, type, text, deleted, seenAt)
     values (1, '$e1', '!a', 'Ana', 'line', 'ana', 'Ana', 0, '2026-10-20T08:00:00.000Z', 'TEXT', 'm1', 0, '2026-10-20T08:00:05.000Z')`
  );
  beeper.close();
  await migrateStored(data);
  expect(existsSync(join(ARCHIVE, "line.sqlite"))).toBe(false);
});

test("a network's reader hides what its bridge backfilled from before its cutover, never the history imported there", () => {
  const archive = mkdtempSync(join(tmpdir(), "archive-"));
  const db = openBridged("line", archive);
  db.run("insert into cutover values ('2026-10-29T17:00:00.000Z')");
  const row = (id: number, at: string, seenAt: string, words: string) =>
    db.run(
      `insert into messages (id, eventId, chat, chatName, sender, senderName, fromMe, at, type, text, deleted, seenAt)
       values (?, ?, '!r', 'Ana', 'u1', 'Ana', 0, ?, 'm.text', ?, 0, ?)`,
      [id, `$e${id}`, at, words, seenAt]
    );
  row(1, "2026-10-20T08:00:00.000Z", "2026-10-20T08:00:05.000Z", "imported");
  row(2, "2026-10-20T08:00:00.000Z", "2026-10-29T17:01:00.000Z", "backfilled");
  row(3, "2026-10-29T18:00:00.000Z", "2026-10-29T18:00:01.000Z", "new");
  db.close();
  expect(readBridged("line", new Date(0), archive).map((e) => e.text)).toEqual([
    "imported",
    "new",
  ]);
});
