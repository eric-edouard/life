import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { daysBefore, iso, MIN } from "../core/clock";
import { readSettings, setSettings } from "../core/settings";
import { collectHistory, historyMonths, historyWindow } from "./history";
import { reindex } from "./index-writer";
import { INDEX, MEMORY, readIndex, readUnitsOf, UNITS } from "./ledger";
import { readPassages } from "./passages";
import { loadTruth } from "./read-truth";
import { SOURCES } from "./sources";
import { publishUnits, unitDays, writeUnits } from "./unit-writer";
import { gather } from "./units";
import { dayNow, dayStart } from "./zones";

const window = { from: "2024-01-31", to: "2024-03-02" };

test("history is bounded by local months and excludes the nightly's seven days", () => {
  expect(historyMonths(window)).toEqual([
    { from: "2024-01-31", to: "2024-01-31" },
    { from: "2024-02-01", to: "2024-02-29" },
    { from: "2024-03-01", to: "2024-03-02" },
  ]);
  expect(unitDays({ from: "2024-02-28", to: "2024-03-01" })).toEqual([
    "2024-02-28",
    "2024-02-29",
    "2024-03-01",
  ]);
  expect(historyWindow("2024-01-01").to).toBe(daysBefore(dayNow(), 7));
  expect(() => historyWindow("2024-01-01", daysBefore(dayNow(), 6))).toThrow(
    "seven-day"
  );
  expect(() => historyWindow("2024-03-01", "2024-01-01")).toThrow("ordered");
});

test("historical collection has no voice/files model step; failed publication leaves units and downstream memory intact; retry clears empty days and preserves voice", async () => {
  const { sources } = readSettings();
  const date = "2024-02-20";
  const hadDirectory = existsSync(UNITS);
  const path = join(UNITS, `${date}.jsonl`);
  const had = existsSync(path) ? readFileSync(path) : undefined;
  const otherPaths = [
    "verdicts.jsonl",
    "ratings.jsonl",
    "appointments.json",
    "ledger.jsonl",
    "extracted.jsonl",
    "people-inferred.jsonl",
  ];
  const snapshot = () =>
    otherPaths.map((p) =>
      existsSync(join(MEMORY, p)) ? readFileSync(join(MEMORY, p), "utf8") : null
    );
  const before = snapshot();
  try {
    setSettings({ sources: [] });
    const evidence = await gather(
      { from: date, to: date },
      { resolve: () => null, truth: await loadTruth() },
      { historical: true }
    );
    expect(evidence.files).toBeUndefined();
    expect(evidence.skipped).toContain("lifelog");
    expect(evidence.conversations).toEqual([]);
    const voice = {
      date,
      end: `${date}T10:00:00.000Z`,
      hash: "0123456789abcdef",
      id: "unit_00000000000a",
      key: "made-up-conversation",
      people: [],
      refs: ["made-up#chapter"],
      schemaVersion: 1 as const,
      source: "lifelog" as const,
      start: `${date}T09:00:00.000Z`,
      stats: { chars: 40, fromMe: 1, items: 1 },
      summary: "A made-up chapter",
      title: "A visit",
    };
    const chat = {
      ...voice,
      id: "unit_00000000000b",
      source: "whatsapp" as const,
      summary: undefined,
    };
    await writeUnits([date], [voice, chat]);
    const stored = readFileSync(path, "utf8");
    await expect(
      publishUnits({ ...evidence, failed: ["whatsapp"] })
    ).rejects.toThrow("sources failed");
    expect(readFileSync(path, "utf8")).toBe(stored);
    await publishUnits({ ...evidence, skipped: ["whatsapp", "lifelog"] });
    expect(readUnitsOf([date]).map((u) => u.id)).toEqual([voice.id, chat.id]);
    await publishUnits({ ...evidence, skipped: ["lifelog"] });
    expect(readUnitsOf([date])).toEqual([voice]);
    await publishUnits({ ...evidence, skipped: ["lifelog"] });
    expect(readUnitsOf([date])).toEqual([voice]);
    expect(snapshot()).toEqual(before);
  } finally {
    setSettings({ sources });
    if (had) {
      await Bun.write(path, had);
    } else {
      rmSync(path, { force: true });
    }
    if (!hadDirectory) {
      rmSync(UNITS, { force: true, recursive: true });
    }
  }
});

test("a failed later month preserves its files and reindexes the already published month", async () => {
  const { sources } = readSettings();
  const source = SOURCES.find((s) => s.name === "told");
  if (!source || source.kind === "voice" || source.kind === "repo") {
    throw new Error("missing fixture source");
  }
  const { read } = source;
  const date = "2024-01-20";
  const hadDirectory = existsSync(UNITS);
  const path = join(UNITS, `${date}.jsonl`);
  const next = join(UNITS, "2024-02-01.jsonl");
  const had = existsSync(path) ? readFileSync(path) : undefined;
  const hadNext = existsSync(next) ? readFileSync(next) : undefined;
  const hadIndex = existsSync(INDEX);
  try {
    setSettings({ sources: ["told"] });
    await Bun.write(next, "\n");
    source.read = (since) => {
      if (since.toISOString() >= "2024-02-01T00:00:00.000Z") {
        throw new Error("made-up source failure");
      }
      return [
        {
          at: `${date}T10:00:00.000Z`,
          chat: "made-up-chat",
          fromMe: true,
          id: "told:made-up",
          sender: "me",
          source: "told",
          text: "A made-up visit to the garden",
        },
      ];
    };
    const result = await collectHistory(
      { from: "2024-01-01", to: "2024-02-02" },
      async () => ({
        deferred: [],
        gaps: [],
        runs: [],
      })
    );
    expect(result.failed).toBe(1);
    expect(result.months).toBe(1);
    expect(result.reasons).toContain("sources failed: told");
    const [unit] = readUnitsOf([date]);
    expect(unit).toBeDefined();
    expect(
      readIndex(
        (db) =>
          db
            .query<{ id: string }, [string]>(
              "select id from units where id = ?"
            )
            .get(unit?.id ?? "")?.id
      )
    ).toBe(unit?.id);
    expect(readFileSync(next, "utf8")).toBe("\n");
  } finally {
    source.read = read;
    setSettings({ sources });
    if (had) {
      await Bun.write(path, had);
    } else {
      rmSync(path, { force: true });
    }
    if (hadNext) {
      await Bun.write(next, hadNext);
    } else {
      rmSync(next, { force: true });
    }
    if (!hadDirectory) {
      rmSync(UNITS, { force: true, recursive: true });
    }
    if (hadIndex) {
      await reindex();
    } else {
      rmSync(INDEX, { force: true });
    }
  }
});

test("a conflicting zone just before the requested range defers the complete expanded passage", async () => {
  const { sources } = readSettings();
  const source = SOURCES.find((s) => s.name === "told");
  if (!source || source.kind === "voice" || source.kind === "repo") {
    throw new Error("missing fixture source");
  }
  const { read } = source;
  const date = "2020-05-01";
  const boundary = dayStart(date).getTime();
  const events = [-5, 5].map((offset, i) => ({
    at: iso(boundary + offset * MIN),
    chat: "boundary-case",
    fromMe: true,
    id: `told:boundary-${i}`,
    sender: "me",
    source: "told" as const,
    text: "A made-up midnight conversation",
  }));
  const hadDirectory = existsSync(UNITS);
  const hadIndex = existsSync(INDEX);
  try {
    setSettings({ sources: ["told"] });
    source.read = (from, before) =>
      events.filter(
        (e) =>
          e.at >= from.toISOString() && (!before || e.at < before.toISOString())
      );
    let expanded: { from: string; to: string } | undefined;
    const result = await collectHistory(
      { from: date, to: date },
      async () => ({ deferred: [], gaps: [], runs: [] }),
      (range) => {
        expanded = range;
        return { deferred: ["2020-04-30"], gaps: [], runs: [] };
      }
    );
    expect(expanded).toEqual({ from: "2020-04-30", to: date });
    expect(result.deferred).toContain("2020-04-30");
    expect(
      readPassages({
        from: dayStart("2020-04-30").toISOString(),
        to: dayStart("2020-05-02").toISOString(),
      })
        .flatMap((p) => p.events)
        .filter((e) => e.chat === "boundary-case")
    ).toEqual([]);
  } finally {
    source.read = read;
    setSettings({ sources });
    if (!hadDirectory) {
      rmSync(UNITS, { force: true, recursive: true });
    }
    if (hadIndex) {
      await reindex();
    } else {
      rmSync(INDEX, { force: true });
    }
  }
});
