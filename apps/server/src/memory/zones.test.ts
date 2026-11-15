import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { readPhoneZone } from "../sources/lifelog";
import { lifelogServer } from "../sources/store-fixtures";
import { ZONES } from "./memory-files";
import {
  cutAt,
  dayStart,
  firstZoneDay,
  lastDays,
  noteZone,
  readZoneHere,
  zoneAt,
} from "./zones";

test("a window is whole local days where he was, today included", () => {
  // 11 Oct in Berlin; 5 Oct began in Jakarta (UTC+7).
  const w = lastDays(new Date("2026-10-11T12:30:00Z"), 7);
  expect(w).toEqual({ from: "2026-10-05", to: "2026-10-11" });
  expect(dayStart(w.from).toISOString()).toBe("2026-10-04T17:00:00.000Z");
});

test("his zone at an instant is the latest record before it, the first one before them all, in time order", () => {
  // Lisbon from 2019 is the file's last line: his past, told after the newer records.
  expect(zoneAt("2018-01-01T00:00:00Z")).toBe("Europe/Lisbon");
  // A backfill may not start before it.
  expect(firstZoneDay()).toBe("2019-01-01");
  expect(zoneAt("2020-01-01T00:00:00Z")).toBe("Europe/Lisbon");
  expect(zoneAt("2026-08-02T00:00:00Z")).toBe("Asia/Jakarta");
  expect(zoneAt("2026-10-06T16:59:59Z")).toBe("Asia/Jakarta");
  expect(zoneAt("2026-10-06T17:00:00Z")).toBe("Europe/Berlin");
  expect(zoneAt("2030-01-01T00:00:00Z")).not.toBe("Asia/Jakarta");
  // The day he flew to Germany lasts until Berlin midnight: no hour of it is lost.
  expect(dayStart("2026-10-06").toISOString()).toBe("2026-10-05T17:00:00.000Z");
  expect(dayStart("2026-10-07").toISOString()).toBe("2026-10-06T22:00:00.000Z");
});

test("where he is now: the phone's latest zone, whatever its age; the Mac's only when no phone said one; lifelog unreadable, no change", async () => {
  const mac = () => "Europe/Berlin";
  const phone = (tz: string | null) => () => Promise.resolve(tz);
  // The Life server may run anywhere: the phone says where he is.
  expect(await readZoneHere({ mac, phone: phone("Asia/Jakarta") })).toBe(
    "Asia/Jakarta"
  );
  // No phone ever named a zone (lifelog not set up, or no heartbeat with one): the Mac's.
  expect(await readZoneHere({ mac, phone: phone(null) })).toBe("Europe/Berlin");
  // lifelog set up but unreadable: nothing to record, so the last zone (the phone's) stands; never the server's.
  expect(
    await readZoneHere({
      mac,
      phone: () => Promise.reject(new Error("lifelog down")),
    })
  ).toBeUndefined();
  // The same through lifelog's real status read: a failed request (no route, 404) and an answer it can't read.
  const failing: Record<string, () => unknown>[] = [
    {},
    { "/status": () => ({ phoneHeartbeat: "not a heartbeat" }) },
  ];
  for (const routes of failing) {
    const server = lifelogServer(routes);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one fake lifelog at a time, each sets the settings it is read by
      expect(await readZoneHere({ mac, phone: readPhoneZone })).toBeUndefined();
    } finally {
      server.close();
    }
  }
});

test("a zone noticed is recorded once, from when `cutAt` says; none or the same, nothing", async () => {
  const was = readFileSync(ZONES, "utf8");
  // The fixture's latest move: Lagos from 19 Oct.
  const noon = new Date("2026-11-02T10:00:00.000Z");
  try {
    await noteZone(undefined, noon);
    await noteZone("Africa/Lagos", noon);
    expect(readFileSync(ZONES, "utf8")).toBe(was);
    await noteZone("Asia/Jakarta", noon);
    await noteZone("Asia/Jakarta", noon);
    expect(readFileSync(ZONES, "utf8").slice(was.length)).toBe(
      `${JSON.stringify({ from: cutAt(noon, "Africa/Lagos", "Asia/Jakarta").toISOString(), schemaVersion: 1, tz: "Asia/Jakarta" })}\n`
    );
  } finally {
    writeFileSync(ZONES, was);
  }
});

test("a move takes effect at once on a shared day, else at the next midnight of the zone ahead, so days never go back", () => {
  const noon = new Date("2026-11-02T10:00:00Z");
  expect(cutAt(noon, "Asia/Jakarta", "Europe/Berlin")).toEqual(noon);
  // 20:00Z: 3 Nov 03:00 in Jakarta, 2 Nov 21:00 in Berlin. Either way, Jakarta's 4 Nov starts it.
  const late = new Date("2026-11-02T20:00:00Z");
  expect(cutAt(late, "Asia/Jakarta", "Europe/Berlin").toISOString()).toBe(
    "2026-11-03T17:00:00.000Z"
  );
  expect(cutAt(late, "Europe/Berlin", "Asia/Jakarta").toISOString()).toBe(
    "2026-11-03T17:00:00.000Z"
  );
});
