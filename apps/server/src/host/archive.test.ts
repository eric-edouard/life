import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR, MIN } from "../core/clock";
import { log } from "../core/log";
import { WINDOWS } from "../core/platform";
import { ARCHIVED, keptStores } from "../memory/sources";
import { toAppleS } from "../sources/imessage";
import { copyWhatsapp } from "../sources/whatsapp";
import { appsToOpen, archiveFailing, openIncidents } from "./archive";
import { archiveLine } from "./nightly";

test("the archive opens each closed app, but not again within 10 minutes", () => {
  const now = Date.now();
  expect(appsToOpen(["Notes", "Finder"], now, new Map(), ARCHIVED)).toEqual([
    "WhatsApp",
  ]);
  const opened = new Map([["WhatsApp", now - MIN]]);
  expect(appsToOpen([], now, opened, ARCHIVED)).toEqual(["Notes"]);
  expect(appsToOpen([], now + 540_000, opened, ARCHIVED)).toEqual([
    "WhatsApp",
    "Notes",
  ]);
});

const LINE = /^Archive: FAILED: line from [\d-]+ [\d:]+, still failing: no db$/;

test("an archive incident lives in the log: open until its run.end, listed by the night and failing until then", async () => {
  const step = "archive.line";
  log("run.error", { error: "no db", step });
  log("run.error", { error: "other", step: "memory.nightly" });
  await Bun.sleep(2);
  // The night after it started: still listed, as still failing.
  const since = new Date().toISOString();
  expect(await archiveLine(since)).toMatch(LINE);
  expect((await archiveFailing()).map(([name]) => name)).toEqual(["line"]);
  log("run.end", { step });
  expect(await archiveLine(since)).toBe("Archive: no failure");
  expect(await archiveFailing()).toEqual([]);
  const start = { at: "2026-10-18T10:00:00.000Z", kind: "run.error", step };
  expect(openIncidents([start]).get("line")).toBe(start);
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
  expect(keptStores(["line", "notes"]).map((s) => s.name)).toEqual(
    WINDOWS ? ["line"] : ["line", "notes"]
  );
  expect(keptStores([])).toEqual([]);
  // A bridged network has no app to open.
  expect(appsToOpen([], 1e12, new Map(), keptStores(["line"]))).toEqual([]);
});
