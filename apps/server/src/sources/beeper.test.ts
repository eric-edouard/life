import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { copyBeeper, newestBeeper, readBeeper } from "./beeper";
import { beeperFixture } from "./store-fixtures";

test("the archive keeps the text of Beeper messages deleted or edited later, with Telegram senders resolved to phones", () => {
  const { add, dir, index, now, source } = beeperFixture();
  add(1, "!tg", "TEXT", "pay the carpenter");
  add(2, "!tg", "TEXT", "meet at 9");
  add(3, "!tg", "REACTION", "👍");
  add(4, "!wa", "TEXT", "read from WhatsApp's own archive");
  expect(copyBeeper(source, dir, now)).toBe(2);
  // Message 1 is deleted for everyone: its text is wiped. Message 2 is edited.
  index.run(
    'update mx_room_messages set isDeleted = 1, message = \'{"text":""}\' where id = 1'
  );
  index.run(
    'update mx_room_messages set message = \'{"text":"meet at 10"}\' where id = 2'
  );
  expect(copyBeeper(source, dir, now + 5000)).toBe(2);
  expect(copyBeeper(source, dir, now + 10_000)).toBe(0);

  const events = readBeeper(new Date(now - HOUR), dir, source);
  expect(events.map((e) => e.text).sort()).toEqual([
    "meet at 10",
    "pay the carpenter",
  ]);
  expect(events[0]).toMatchObject({
    chat: "!tg",
    chatName: "Ana",
    fromMe: false,
    sender: "+66600000001",
    source: "beeper",
  });
  expect(events.map((e) => e.id).sort()).toEqual([
    "beeper:!tg/1",
    "beeper:!tg/2",
  ]);
  const deleted = new Database(join(dir, "beeper.sqlite"))
    .query<{ text: string }, []>("select text from deleted")
    .all();
  expect(deleted).toEqual([{ text: "pay the carpenter" }]);
});

test("audit-6-line-account-id: every form of a network's account id is copied under the network's name; WhatsApp is left to its own source", () => {
  const { add, dir, now, source } = beeperFixture();
  add(1, "!ln", "TEXT", "the bank details");
  add(2, "!ig", "TEXT", "see you there");
  add(3, "!tg", "TEXT", "meet at 9");
  add(4, "!wa", "TEXT", "read from WhatsApp's own archive");
  add(5, "!no", "TEXT", "an account that only starts like a network");
  expect(copyBeeper(source, dir, now)).toBe(3);
  const db = new Database(join(dir, "beeper.sqlite"));
  const networks = db
    .query<{ chat: string; network: string }, []>(
      "select chat, network from messages order by chat"
    )
    .all();
  db.close();
  expect(networks).toEqual([
    { chat: "!ig", network: "instagram" },
    { chat: "!ln", network: "line" },
    { chat: "!tg", network: "telegram" },
  ]);
});

test("each network's newest message is that row whole, never another row's words", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-newest-"));
  const db = new Database(join(dir, "beeper.sqlite"));
  db.run(
    "create table messages (network text, at text, chatName text, text text)"
  );
  const add = db.prepare("insert into messages values (?, ?, ?, ?)");
  add.run("line", "2026-10-20T10:00:00.000Z", "Ana", "old");
  add.run("line", "2026-10-21T10:00:00.000Z", "Bo", "newest on line");
  add.run("line", "2026-10-19T10:00:00.000Z", "Cy", "older");
  add.run("telegram", "2026-10-21T12:00:00.000Z", "Di", "newest overall");
  add.finalize(); // an open statement keeps the file open, and Windows refuses to remove it
  db.close();
  expect(newestBeeper(dir)).toEqual({
    at: "2026-10-21T12:00:00.000Z",
    parts: [
      { at: "2026-10-21T12:00:00.000Z", label: "telegram" },
      { at: "2026-10-21T10:00:00.000Z", label: "line" },
    ],
    words: ["telegram: Di: newest overall", "line: Bo: newest on line"],
  });
  rmSync(dir, { force: true, recursive: true });
});
