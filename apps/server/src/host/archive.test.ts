import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR, MIN } from "../core/clock";
import { log } from "../core/log";
import { WINDOWS } from "../core/platform";
import { ARCHIVED, keptStores } from "../memory/sources";
import type { Descriptor } from "../sources/contract";
import { toAppleS } from "../sources/imessage";
import { copyWhatsapp } from "../sources/whatsapp";
import {
  appsToOpen,
  archiveFailing,
  heardIncoming,
  messagesIn,
  openIncidents,
  toStart,
} from "./archive";
import { archiveLine } from "./nightly";

test("the archive opens each closed app, but not again within 10 minutes", () => {
  const now = Date.now();
  expect(appsToOpen(["Notes", "Finder"], now, new Map(), ARCHIVED)).toEqual([
    "WhatsApp",
    "Beeper Desktop",
  ]);
  const opened = new Map([["WhatsApp", now - MIN]]);
  expect(appsToOpen([], now, opened, ARCHIVED)).toEqual([
    "Beeper Desktop",
    "Notes",
  ]);
  expect(appsToOpen([], now + 540_000, opened, ARCHIVED)).toEqual([
    "WhatsApp",
    "Beeper Desktop",
    "Notes",
  ]);
});

const LINE =
  /^Archive: FAILED: beeper from [\d-]+ [\d:]+, still failing: no db$/;

test("an archive incident lives in the log: open until its run.end, listed by the night and due for an email an hour in", async () => {
  const step = "archive.beeper";
  log("run.error", { error: "no db", step });
  log("run.error", { error: "other", step: "memory.nightly" });
  await Bun.sleep(2);
  // The night after it started: still listed, as still failing.
  const since = new Date().toISOString();
  expect(await archiveLine(since)).toMatch(LINE);
  expect((await archiveFailing()).map(([name]) => name)).toEqual(["beeper"]);
  expect(await archiveFailing(HOUR)).toEqual([]);
  expect((await archiveFailing(HOUR, Date.now() + HOUR)).length).toBe(1);
  log("run.end", { step });
  expect(await archiveLine(since)).toBe("Archive: no failure");
  expect(await archiveFailing()).toEqual([]);
  const start = { at: "2026-10-18T10:00:00.000Z", kind: "run.error", step };
  expect(openIncidents([start]).get("beeper")).toBe(start);
});

test("a message deleted for everyone keeps its text and media in the archive", () => {
  const source = mkdtempSync(join(tmpdir(), "wa-"));
  const dir = mkdtempSync(join(tmpdir(), "archive-"));
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
  wa.run("insert into ZWACHATSESSION values (1, '66@s.whatsapp.net', 'Ana')");
  wa.run("insert into ZWAMEDIAITEM values (1, 'Media/a.jpg')");
  const now = Date.now();
  const date = toAppleS(now) - 60;
  wa.run(
    "insert into ZWAMESSAGE values (1, 'S1', 1, 0, ?, 'see you at 8', 1, 1, null, '66@s.whatsapp.net', null)",
    [date]
  );
  mkdirSync(join(source, "Message/Media"), { recursive: true });
  writeFileSync(join(source, "Message/Media/a.jpg"), "photo");

  expect(copyWhatsapp(source, dir, now)).toBe(1);
  // Delete for everyone: WhatsApp removes the original and adds a placeholder with a new id at the same time.
  wa.run("delete from ZWAMESSAGE");
  wa.run("delete from ZWAMEDIAITEM");
  wa.run(
    "insert into ZWAMESSAGE values (2, 'S2', 14, 0, ?, null, null, 1, null, '66@s.whatsapp.net', null)",
    [date]
  );
  expect(copyWhatsapp(source, dir, now + 5000)).toBe(1);
  expect(copyWhatsapp(source, dir, now + 10_000)).toBe(0);

  const deleted = new Database(join(dir, "whatsapp.sqlite"))
    .query<{ chatName: string; media: string; text: string }, []>(
      "select chatName, text, media from deleted"
    )
    .all();
  expect(deleted).toEqual([
    { chatName: "Ana", media: "Media/a.jpg", text: "see you at 8" },
  ]);
  expect(readFileSync(join(dir, "media/Media/a.jpg"), "utf8")).toBe("photo");
});

test("only the stores of the sources he turned on are copied and kept open", () => {
  expect(keptStores(["notes", "imessage"]).map((s) => s.name)).toEqual(
    WINDOWS ? [] : ["notes"]
  );
  // A Mac-only app is never opened elsewhere; the others are.
  expect(keptStores(["beeper", "notes"]).map((s) => s.name)).toEqual(
    WINDOWS ? ["beeper"] : ["beeper", "notes"]
  );
  expect(keptStores([])).toEqual([]);
  expect(appsToOpen([], 1e12, new Map(), keptStores(["beeper"]))).toEqual([
    "Beeper Desktop",
  ]);
});

test("a pass starts the agent for the chats someone else wrote in, never for his own messages or older copies", () => {
  const dir = mkdtempSync(join(tmpdir(), "archive-"));
  const db = new Database(join(dir, "whatsapp.sqlite"));
  db.run("create table messages (chat text, fromMe integer, seenAt text)");
  db.run(
    `insert into messages values ('66@s.whatsapp.net', 0, '2026-10-29T10:00:05Z'),
      ('66@s.whatsapp.net', 0, '2026-10-29T10:00:06Z'), ('33@s.whatsapp.net', 1, '2026-10-29T10:00:05Z'),
      ('44@s.whatsapp.net', 0, '2026-10-29T09:59:00Z')`
  );
  const whatsapp = ARCHIVED.find((s) => s.name === "whatsapp");
  if (!whatsapp) {
    throw new Error("no whatsapp descriptor");
  }
  expect(messagesIn(whatsapp, "2026-10-29T10:00:00Z", dir)).toEqual([
    { chat: "66@s.whatsapp.net", source: "whatsapp" },
  ]);
  // Notes are his own writing: never a message event.
  const notes = ARCHIVED.find((s) => s.kind !== "chat");
  expect(notes && messagesIn(notes, "2026-10-29T10:00:00Z", dir)).toEqual([]);
});

test("a chat starts the agent once a minute at most", () => {
  const starts = new Map();
  const ana = [{ chat: "66@s.whatsapp.net", source: "whatsapp" as const }];
  expect(toStart(ana, starts, HOUR)).toEqual(ana);
  // Heard again 5 s later: it waits for its minute, then starts with nothing new heard.
  expect(toStart(ana, starts, HOUR + 5000)).toEqual([]);
  expect(toStart([], starts, HOUR + MIN)).toEqual(ana);
  expect(toStart([], starts, HOUR + 2 * MIN)).toEqual([]);
});

test("a source with no archive tells of someone else's messages after its cursor, and keeps the cursor when it fails", () => {
  const cursors = new Map<string, number>();
  const imessage = {
    incoming: (after: number | undefined) =>
      after === undefined
        ? { chats: [], last: 7 }
        : { chats: ["+15550100"], last: 9 },
    name: "imessage",
  } as unknown as Descriptor;
  expect(heardIncoming(cursors, new Set(), [imessage])).toEqual([]);
  expect(heardIncoming(cursors, new Set(), [imessage])).toEqual([
    { chat: "+15550100", source: "imessage" },
  ]);
  expect(cursors.get("imessage")).toBe(9);
  const broken = {
    incoming: () => {
      throw new Error("chat.db locked");
    },
    name: "imessage",
  } as unknown as Descriptor;
  expect(heardIncoming(cursors, new Set(), [broken])).toEqual([]);
  expect(cursors.get("imessage")).toBe(9);
});
