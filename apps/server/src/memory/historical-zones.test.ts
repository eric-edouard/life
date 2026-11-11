import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNITS, ZONES } from "./ledger";
import {
  historicalZonesOf,
  parseMailZone,
  prepareHistoricalZones,
  readHistoricalZones,
  zoneAt,
} from "./zones";

const sent = (day: string, offset: string) => ({
  at: `${day}T12:00:00Z`,
  date: `${day} 12:00:00 ${offset}`,
});

test("sent-mail offsets retain the IANA sign and reject unknown or non-hour offsets", () => {
  expect(parseMailZone("Mon, 2 Jan 2023 12:00:00 +0700")).toBe("Etc/GMT-7");
  expect(parseMailZone("Mon, 2 Jan 2023 12:00:00 -0500")).toBe("Etc/GMT+5");
  expect(parseMailZone("Mon, 2 Jan 2023 12:00:00 +0000")).toBe("Etc/GMT");
  expect(parseMailZone("Mon, 2 Jan 2023 12:00:00 -0000")).toBeUndefined();
  expect(parseMailZone("Mon, 2 Jan 2023 12:00:00 +0530")).toBeUndefined();
  expect(parseMailZone(undefined)).toBeUndefined();
});

test("historical runs use nearest evidence for gaps, ties earlier, and defer conflicting/non-hour days", () => {
  const report = historicalZonesOf(
    [
      sent("2023-01-02", "+0700"),
      sent("2023-01-06", "-0500"),
      sent("2023-01-07", "+0530"),
      sent("2023-01-08", "+0700"),
      sent("2023-01-08", "-0500"),
    ],
    { from: "2023-01-01", to: "2023-01-09" }
  );
  expect(report.gaps).toEqual([
    "2023-01-01",
    "2023-01-03",
    "2023-01-04",
    "2023-01-05",
    "2023-01-09",
  ]);
  expect(report.deferred).toEqual(["2023-01-07", "2023-01-08"]);
  expect(report.runs).toEqual([
    { from: "2022-12-31T17:00:00.000Z", tz: "Etc/GMT-7" },
    { from: "2023-01-05T05:00:00.000Z", tz: "Etc/GMT+5" },
  ]);
});

test("a non-hour offset near midnight defers its sent local day, not its received UTC day", () => {
  const report = historicalZonesOf(
    [
      { at: "2023-01-01T19:00:00Z", date: "2 Jan 2023 00:30:00 +0530" },
      sent("2023-01-01", "+0700"),
    ],
    { from: "2023-01-01", to: "2023-01-02" }
  );
  expect(report.deferred).toEqual(["2023-01-02"]);
});

test("zone preparation retains gaps but appends no zones on or after existing coverage", async () => {
  const was = readFileSync(ZONES, "utf8");
  let reads = 0;
  try {
    const result = await prepareHistoricalZones(
      { from: "2026-01-01", to: "2026-01-03" },
      () => {
        reads += 1;
        return [sent("2026-01-01", "+0700")];
      }
    );
    expect(result.runs).toEqual([]);
    expect(reads).toBe(1);
    expect(readFileSync(ZONES, "utf8")).toBe(was);
  } finally {
    writeFileSync(ZONES, was);
  }
});

test("past zone runs stop strictly before the first day containing units, including retries", async () => {
  const was = readFileSync(ZONES, "utf8");
  const path = join(UNITS, "2018-01-02.jsonl");
  mkdirSync(UNITS, { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ date: "2018-01-02", end: "2018-01-02T12:00:00Z", hash: "a".repeat(16), id: "unit_aaaaaaaaaaaa", key: "test", people: [], refs: ["test"], schemaVersion: 1, source: "imessage", start: "2018-01-02T12:00:00Z", stats: { chars: 20, fromMe: 1, items: 1 }, title: "Example" })}\n`
  );
  try {
    writeFileSync(
      ZONES,
      `${JSON.stringify({ from: "2018-01-02T05:00:00Z", schemaVersion: 1, tz: "Etc/GMT+5" })}\n`
    );
    const report = await prepareHistoricalZones(
      { from: "2018-01-01", to: "2018-01-03" },
      () => [sent("2018-01-01", "+0700"), sent("2018-01-02", "-0500")]
    );
    expect(report.runs).toEqual([
      { from: "2017-12-31T17:00:00.000Z", tz: "Etc/GMT-7" },
    ]);
    const after = readFileSync(ZONES, "utf8");
    await prepareHistoricalZones(
      { from: "2018-01-01", to: "2018-01-03" },
      () => [sent("2018-01-01", "+0700"), sent("2018-01-02", "-0500")]
    );
    expect(readFileSync(ZONES, "utf8")).toBe(after);
  } finally {
    rmSync(path);
    writeFileSync(ZONES, was);
  }
});

test("a date-line offset jump cannot publish decreasing run boundaries", () => {
  const report = historicalZonesOf(
    [sent("2023-01-01", "-1200"), sent("2023-01-02", "+1400")],
    { from: "2023-01-01", to: "2023-01-02" }
  );
  expect(report.deferred).toEqual(["2023-01-02"]);
  expect(report.runs).toHaveLength(1);
});

test("repeated preparation keeps conflicting and non-hour days deferred after runs were appended", async () => {
  const was = readFileSync(ZONES, "utf8");
  const read = () => [
    sent("2017-01-01", "+0700"),
    sent("2017-01-02", "+0700"),
    sent("2017-01-02", "-0500"),
    sent("2017-01-03", "+0530"),
  ];
  try {
    const window = { from: "2017-01-01", to: "2017-01-04" };
    const first = await prepareHistoricalZones(window, read);
    const next = await prepareHistoricalZones(window, read);
    expect(next.deferred).toEqual(first.deferred);
    expect(next.gaps).toEqual(first.gaps);
    expect(next.runs).toEqual([]);
    expect(next.deferred).toEqual(["2017-01-02", "2017-01-03"]);
  } finally {
    writeFileSync(ZONES, was);
  }
});

test("mail never defers a day a recorded zone covers, and the mail era stays put after a run was appended", async () => {
  const was = readFileSync(ZONES, "utf8");
  const read = () => [
    sent("2019-01-06", "+0700"),
    sent("2019-01-08", "+0700"),
    sent("2019-01-08", "-0500"),
    sent("2019-01-12", "+0700"),
    sent("2019-01-12", "-0500"),
  ];
  try {
    writeFileSync(
      ZONES,
      `${JSON.stringify({ from: "2019-01-10T00:00:00Z", schemaVersion: 1, tz: "Etc/GMT" })}\n`
    );
    const window = { from: "2019-01-06", to: "2019-01-12" };
    const first = await prepareHistoricalZones(window, read);
    expect(first.deferred).toEqual(["2019-01-08"]);
    expect(first.gaps).toEqual(["2019-01-07", "2019-01-09"]);
    expect(first.runs).toEqual([
      { from: "2019-01-05T17:00:00.000Z", tz: "Etc/GMT-7" },
    ]);
    const after = readFileSync(ZONES, "utf8");
    const next = await prepareHistoricalZones(window, read);
    expect(next.deferred).toEqual(first.deferred);
    expect(next.runs).toEqual([]);
    expect(readFileSync(ZONES, "utf8")).toBe(after);
  } finally {
    writeFileSync(ZONES, was);
  }
});

test("a window entirely after the mail era has no deferrals, gaps or runs", async () => {
  const report = await prepareHistoricalZones(
    { from: "2020-01-01", to: "2020-01-02" },
    () => [sent("2020-01-01", "+0530"), sent("2020-01-02", "+0700")]
  );
  expect(report.deferred).toEqual([]);
  expect(report.gaps).toEqual([]);
  expect(report.runs).toEqual([]);
});

test("prepending a zone never extends a new offset into already stored units", async () => {
  const was = readFileSync(ZONES, "utf8");
  const path = join(UNITS, "2018-01-02.jsonl");
  mkdirSync(UNITS, { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ date: "2018-01-02", end: "2018-01-02T12:00:00Z", hash: "a".repeat(16), id: "unit_aaaaaaaaaaaa", key: "test", people: [], refs: ["test"], schemaVersion: 1, source: "imessage", start: "2018-01-02T12:00:00Z", stats: { chars: 20, fromMe: 1, items: 1 }, title: "Example" })}\n`
  );
  try {
    const before = zoneAt("2018-01-02T12:00:00Z");
    const report = await prepareHistoricalZones(
      { from: "2018-01-01", to: "2018-01-01" },
      () => [sent("2018-01-01", "+0700")]
    );
    expect(report.runs).toEqual([]);
    expect(report.reasons).toHaveLength(1);
    expect(zoneAt("2018-01-02T12:00:00Z")).toBe(before);
    expect(readFileSync(ZONES, "utf8")).toBe(was);
  } finally {
    rmSync(path);
    writeFileSync(ZONES, was);
  }
});

test("read-only historical uncertainty survives an earlier zone append without writing anything", async () => {
  const was = readFileSync(ZONES, "utf8");
  const read = () => [sent("2017-01-01", "+0700"), sent("2017-01-02", "+0530")];
  try {
    const window = { from: "2017-01-01", to: "2017-01-03" };
    await prepareHistoricalZones(window, read);
    const after = readFileSync(ZONES, "utf8");
    const report = await readHistoricalZones(window, read);
    expect(report.deferred).toEqual(["2017-01-02"]);
    expect(report.gaps).toEqual(["2017-01-03"]);
    expect(readFileSync(ZONES, "utf8")).toBe(after);
  } finally {
    writeFileSync(ZONES, was);
  }
});

test("a midday initial zone protects stored units earlier on that same day", async () => {
  const was = readFileSync(ZONES, "utf8");
  const path = join(UNITS, "2018-01-02.jsonl");
  mkdirSync(UNITS, { recursive: true });
  const instant = "2018-01-02T00:30:00Z";
  writeFileSync(
    path,
    `${JSON.stringify({ date: "2018-01-02", end: instant, hash: "a".repeat(16), id: "unit_aaaaaaaaaaaa", key: "test", people: [], refs: ["test"], schemaVersion: 1, source: "imessage", start: instant, stats: { chars: 20, fromMe: 1, items: 1 }, title: "Example" })}\n`
  );
  try {
    writeFileSync(
      ZONES,
      `${JSON.stringify({ from: "2018-01-02T12:00:00Z", schemaVersion: 1, tz: "Etc/GMT" })}\n`
    );
    const initial = readFileSync(ZONES, "utf8");
    const report = await prepareHistoricalZones(
      { from: "2018-01-01", to: "2018-01-01" },
      () => [sent("2018-01-01", "-0500")]
    );
    expect(report.runs).toEqual([]);
    expect(report.reasons).toHaveLength(1);
    expect(zoneAt(instant)).toBe("Etc/GMT");
    expect(readFileSync(ZONES, "utf8")).toBe(initial);
  } finally {
    rmSync(path);
    writeFileSync(ZONES, was);
  }
});
