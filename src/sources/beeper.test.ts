import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveBeeperOnce } from "../archive";
import { showFiles } from "../memory/files";
import { newestBeeper, readBeeper } from "./beeper";
import { beeperFixture } from "./fixtures";

test("an attachment is a file the archive keeps, at Beeper's cached copy when it fetched one, even once deleted", () => {
  const { add, dir, index, now, source } = beeperFixture();
  const cache = join(source, "media", "localhostlocal-telegram");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "AAM1"), "bytes");
  add(1, "!tg", "IMAGE", "", [
    {
      fileName: "image.jpg",
      id: "localmxc://local-telegram/AAM1",
      mimeType: "image/jpeg",
      srcURL: "localmxc://local-telegram/AAM1",
    },
  ]);
  add(2, "!tg", "VOICE", "", [
    {
      fileName: "audioclip.mp4",
      id: "localmxc://local-instagram/BAA2",
      isVoiceNote: true,
      mimeType: "video/mp4",
    },
  ]);
  expect(archiveBeeperOnce(source, dir, now)).toBe(4);
  const read = (d: Date) => readBeeper(d, dir, source);
  const since = new Date(now - 3_600_000);
  expect(read(since).map((e) => e.files)).toEqual([
    [
      {
        mime: "image/jpeg",
        name: "image.jpg",
        path: join(cache, "AAM1"),
        ref: "beeper:localmxc://local-telegram/AAM1",
      },
    ],
    [
      {
        mime: "audio/mp4",
        name: "audioclip.mp4",
        ref: "beeper:localmxc://local-instagram/BAA2",
      },
    ],
  ]);
  expect(showFiles(read(since), new Map()).map((e) => e.text)).toEqual([
    "[photo image.jpg]",
    "[audio audioclip.mp4, not on this Mac]",
  ]);
  // The photo is edited to another, then deleted for everyone: Beeper wipes its attachments. Its latest line stays,
  // marked, read from the archive only.
  index.run(
    'update mx_room_messages set message = \'{"attachments":[{"fileName":"edited.jpg","id":"x"}],"text":""}\' where id = 1'
  );
  expect(archiveBeeperOnce(source, dir, now + 2500)).toBe(1);
  index.run(
    'update mx_room_messages set isDeleted = 1, message = \'{"attachments":[],"text":""}\' where id = 1'
  );
  archiveBeeperOnce(source, dir, now + 5000);
  index.close();
  rmSync(join(source, "index.db"));
  const [photo] = showFiles(read(since), new Map());
  expect(photo).toMatchObject({
    deleted: true,
    text: "[photo edited.jpg, not on this Mac]",
  });
});

test("the archive keeps the text of Beeper messages deleted or edited later, with Telegram senders resolved to phones", () => {
  const { add, dir, index, now, source } = beeperFixture();
  add(1, "!tg", "TEXT", "pay the carpenter");
  add(2, "!tg", "TEXT", "meet at 9");
  add(3, "!tg", "REACTION", "👍");
  add(4, "!wa", "TEXT", "read from WhatsApp's own archive");
  expect(archiveBeeperOnce(source, dir, now)).toBe(2);
  // Message 1 is deleted for everyone: its text is wiped. Message 2 is edited.
  index.run(
    'update mx_room_messages set isDeleted = 1, message = \'{"text":""}\' where id = 1'
  );
  index.run(
    'update mx_room_messages set message = \'{"text":"meet at 10"}\' where id = 2'
  );
  expect(archiveBeeperOnce(source, dir, now + 5000)).toBe(2);
  expect(archiveBeeperOnce(source, dir, now + 10_000)).toBe(0);

  const events = readBeeper(new Date(now - 3_600_000), dir, source);
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
