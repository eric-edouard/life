import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR, MIN } from "../core/clock";
import { log, recentEvents } from "../core/log";
import { MACHINE_DIR, WINDOWS } from "../core/platform";
import { ARCHIVED, type Archived, keptStores } from "../memory/sources";
import { ARCHIVE } from "../sources/archived";
import { toAppleS } from "../sources/imessage";
import { whatsappFixture } from "../sources/store-fixtures";
import { copyWhatsapp } from "../sources/whatsapp";
import {
  ARCHIVE_LOOKBACK,
  appsToOpen,
  archiveCommand,
  archiveFailing,
  copyAll,
  openIncidents,
} from "./archive";
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

test("a store whose app can't be told now (a bridge restarting) is skipped, the others still opened", () => {
  const [first, ...rest] = ARCHIVED;
  const failing = {
    ...first,
    store: {
      ...first?.store,
      get app(): string {
        throw new Error("unable to open database file");
      },
    },
  } as Archived;
  expect(appsToOpen([], 1e12, new Map(), [failing, ...rest])).toEqual(
    appsToOpen([], 1e12, new Map(), rest)
  );
});

const LINE = /^Archive: FAILED: line from [\d-]+ [\d:]+, still failing: no db$/;

test("an archive incident lives in the log: open until its run.end, listed by the night and failing until then", async () => {
  const step = "archive.line";
  log("run.error", { error: "no db", step });
  log("run.error", { error: "other", step: "memory.nightly" });
  await Bun.sleep(2);
  // The night after it started: still listed, as still failing.
  const since = new Date().toISOString();
  const later = Date.now() + HOUR;
  expect(await archiveLine(since)).toMatch(LINE);
  // One failed 5 s pass is no outage: failing only once the incident has been open an hour.
  expect(await archiveFailing()).toEqual([]);
  expect((await archiveFailing(later)).map(([name]) => name)).toEqual(["line"]);
  log("run.end", { step });
  expect(await archiveLine(since)).toBe("Archive: no failure");
  expect(await archiveFailing(later)).toEqual([]);
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
  wa.run(
    "create table ZWAMEDIAITEM (Z_PK integer, ZMEDIALOCALPATH text, ZMETADATA blob)"
  );
  wa.run(
    "create table ZWAGROUPMEMBER (Z_PK integer, ZMEMBERJID text, ZCONTACTNAME text)"
  );
  wa.run("insert into ZWACHATSESSION values (1, '66@s.whatsapp.net', 'Ana')");
  wa.run(
    "insert into ZWAMEDIAITEM (Z_PK, ZMEDIALOCALPATH) values (1, 'Media/a.jpg')"
  );
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

test("archive whatsapp validates its folder, holds the archive lock and copies once in full", async () => {
  expect(await archiveCommand(["whatsapp"])).toBe(2);
  const { add, now, source, wa } = whatsappFixture();
  expect(await archiveCommand(["whatsapp", source, "extra"])).toBe(2);
  expect(await archiveCommand(["whatsapp", join(source, "missing")])).toBe(2);
  expect(existsSync(join(MACHINE_DIR, "archive.lock"))).toBe(false);
  add(1, "seed", 0, "already archived");
  copyWhatsapp(source, ARCHIVE, now);
  add(2, "ancient", 0, "older history", 4000 * 86_400);
  try {
    expect(await archiveCommand(["whatsapp", source])).toBe(0);
    expect(
      readFileSync(join(MACHINE_DIR, "archive.lock"), "utf8").split("\n")[0]
    ).toBe(String(process.pid));
    const db = new Database(join(ARCHIVE, "whatsapp.sqlite"), {
      readonly: true,
    });
    try {
      expect(db.query("select id from messages order by id").all()).toEqual([
        { id: "ancient" },
        { id: "seed" },
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(join(MACHINE_DIR, "archive.lock"), { force: true });
    rmSync(ARCHIVE, { force: true, recursive: true });
    wa.close();
  }
});

test("an incident opened 10 minutes before a restart is still open at startup, so its next good pass closes it", async () => {
  const step = "archive.whatsapp";
  log("run.error", { error: "busy", step });
  expect([
    ...openIncidents(await recentEvents(ARCHIVE_LOOKBACK)).keys(),
  ]).toContain("whatsapp");
  expect(await archiveFailing(Date.now() + 10 * MIN)).toEqual([]);
  log("run.end", { step });
});

/** A made-up kept store: `copy` is what the pass calls. */
const kept = (name: string, copy: () => unknown) =>
  ({ name, store: { copy } }) as never;

test("copyAll: a copy that never ends holds no other store, and the next pass skips it while it runs", () => {
  let slow = 0;
  let fast = 0;
  const stores = [
    kept("slownet", () => {
      slow += 1;
      return new Promise(() => undefined);
    }),
    kept("quick", () => {
      fast += 1;
    }),
  ];
  const failing = new Set<string>();
  // Not awaited: the first never ends. The sync store was copied all the same.
  copyAll(failing, stores);
  expect([slow, fast]).toEqual([1, 1]);
  copyAll(failing, stores);
  expect([slow, fast]).toEqual([1, 2]);
});

test("copyAll: a rejecting async copy opens one incident, however many passes fail, and a later success closes it", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => undefined);
  let works = false as boolean;
  const net = kept("flaky", () =>
    works ? Promise.resolve() : Promise.reject(new Error("offline"))
  );
  const failing = new Set<string>();
  await copyAll(failing, [net]);
  await copyAll(failing, [net]);
  expect([...failing]).toEqual(["flaky"]);
  const lines = (await recentEvents(ARCHIVE_LOOKBACK)).filter(
    (e) => e.step === "archive.flaky"
  );
  expect(lines.map((e) => e.kind)).toEqual(["run.error"]);
  expect(openIncidents(lines).has("flaky")).toBe(true);
  works = true;
  await copyAll(failing, [net]);
  expect(failing.size).toBe(0);
  const after = (await recentEvents(ARCHIVE_LOOKBACK)).filter(
    (e) => e.step === "archive.flaky"
  );
  expect(after.map((e) => e.kind)).toEqual(["run.error", "run.end"]);
  quiet.mockRestore();
});
