import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DAY } from "../core/clock";
import { LOG_DIR } from "../core/log";
import { latestExtractions, OUT } from "../memory/memory-files";
import { unit } from "../memory/record-fixtures";
import type { Extracted, Observation } from "../records/observation";
import {
  dropOld,
  markedSince,
  nightly,
  runNight,
  runProcessing,
} from "./nightly";

test("each marked unit is listed once read since the last night, with the observations citing its marked lines", () => {
  const u = unit({ marked: ["j:1@a", "j:2@a"] });
  const built = [
    { messages: [], text: "", unit: u },
    { messages: [], text: "", unit: unit({ id: "unit_000000000002" }) },
  ];
  const read = (at: string, id = u.id, unitHash = u.hash) =>
    ({ at, unit: id, unitHash }) as Extracted;
  const latest = (...lines: Extracted[]) => latestExtractions(lines);
  const held = {
    source: { channel: "lifelog", ref: "j:2@a" },
    text: "He will vote for the stones.",
  } as Observation;
  const since = "2026-10-10T02:00:00.000Z";
  const after = latest(
    read("2026-10-10T13:00:00.000Z"),
    read("2026-10-10T13:00:00.000Z", "unit_000000000002")
  );
  expect(
    markedSince(built, after, since, [held]).map((m) => m.relation)
  ).toEqual(["Shop repairs → He will vote for the stones."]);
  expect(markedSince(built, after, since, [])[0]?.relation).toBe(
    "Shop repairs → nothing held"
  );
  // Read before the last night, or since but before the mark changed its content: not listed.
  expect(
    markedSince(
      built,
      latest(read("2026-10-10T13:00:00.000Z", u.id, "unmarked0000000")),
      since,
      [held]
    )
  ).toEqual([]);
  expect(
    markedSince(built, latest(read("2026-10-09T13:00:00.000Z")), since, [held])
  ).toEqual([]);
});

test("while another install's watcher runs on this Mac, a tick does nothing", async () => {
  const locks = await import("../core/lock");
  const live = spyOn(locks, "holder").mockReturnValue({
    note: "/elsewhere/state",
    pid: String(process.pid),
    since: new Date("2026-11-01T00:00:00Z"),
  });
  const said = spyOn(console, "log");
  try {
    expect(await nightly(7)).toBe(0);
    expect(said.mock.calls.flat().join(" ")).toContain(
      "another Life runs here"
    );
  } finally {
    said.mockRestore();
    live.mockRestore();
  }
});

test("offline (his model provider unreachable), a tick runs nothing", async () => {
  const offline = spyOn(globalThis, "fetch").mockRejectedValue(
    new TypeError("fetch failed")
  );
  const said = spyOn(console, "log");
  try {
    expect(await nightly(7)).toBe(0);
    expect(said.mock.calls.flat().join(" ")).toContain("offline: no tick");
  } finally {
    said.mockRestore();
    offline.mockRestore();
  }
});

test("the night drops run and eval folders past 30 days and log days past a year, nothing newer", async () => {
  const now = new Date("2026-11-05T03:00:00Z");
  const run = (name: string, age: number, folder = "runs") => {
    const dir = join(OUT, folder, name);
    mkdirSync(dir, { recursive: true });
    const t = (now.getTime() - age * DAY) / 1000;
    utimesSync(dir, t, t);
    return dir;
  };
  const old = run("extract-old", 31);
  const kept = run("extract-new", 29);
  const oldEval = run("eval-old", 31, "evals");
  const keptEval = run("eval-new", 29, "evals");
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(join(LOG_DIR, "2025-11-04.jsonl"), "");
  writeFileSync(join(LOG_DIR, "2025-11-05.jsonl"), "");
  try {
    await dropOld(now);
    expect([old, kept, oldEval, keptEval].map((d) => existsSync(d))).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect(existsSync(join(LOG_DIR, "2025-11-04.jsonl"))).toBe(false);
    expect(existsSync(join(LOG_DIR, "2025-11-05.jsonl"))).toBe(true);
  } finally {
    rmSync(join(OUT, "runs"), { force: true, recursive: true });
    rmSync(join(OUT, "evals"), { force: true, recursive: true });
    rmSync(join(LOG_DIR, "2025-11-05.jsonl"), { force: true });
  }
});

test("a queued historical backfill is withheld from the scheduler until prompts are ready", async () => {
  const locks = await import("../core/lock");
  const models = await import("../models/llm");
  const zones = await import("../memory/zones");
  const schedule = await import("../memory/schedule");
  const stopped = new Error("schedule inspected");
  const live = spyOn(locks, "holder").mockReturnValue(null);
  const online = spyOn(models, "isOnline").mockResolvedValue(true);
  const quota = spyOn(models, "quota").mockResolvedValue(undefined);
  const here = spyOn(zones, "readZoneHere").mockResolvedValue(undefined);
  const queued = spyOn(schedule, "readBackfill").mockReturnValue({
    failures: 0,
    next: "2025-01-01",
    to: "2025-12-31",
  });
  const turn = spyOn(schedule, "turnOf").mockImplementation(() => {
    throw stopped;
  });
  try {
    await expect(nightly(7)).rejects.toThrow(stopped);
    const states = turn.mock.calls.at(0)?.[2];
    expect(states).toBeDefined();
    expect(states?.backfill).toBeUndefined();
    expect(queued).not.toHaveBeenCalled();
  } finally {
    turn.mockRestore();
    queued.mockRestore();
    here.mockRestore();
    quota.mockRestore();
    online.mockRestore();
    live.mockRestore();
  }
});

test("the night places matters after extraction, with the evidence's failed sources; the backfill's processing run does not", async () => {
  const stopped = new Error("stopped after matters");
  const mods = {
    contacts: await import("../memory/contact-people"),
    episodes: await import("../memory/episodes"),
    extract: await import("../memory/extract"),
    index: await import("../memory/index-writer"),
    matters: await import("../memory/matters"),
    models: await import("../models/llm"),
    recorded: await import("../memory/recorded-days"),
    repos: await import("../memory/repos"),
    settings: await import("../core/settings"),
    units: await import("../memory/units"),
    who: await import("../memory/who"),
  };
  const none = { failed: 0 } as never;
  const spies = [
    spyOn(mods.settings, "settings").mockReturnValue({
      engine: "claude",
      matters: true,
    } as never),
    spyOn(mods.who, "readPeople").mockResolvedValue({} as never),
    spyOn(mods.units, "gather").mockResolvedValue({
      failed: ["mail"],
    } as never),
    spyOn(mods.episodes, "episodes").mockResolvedValue(none),
    spyOn(mods.extract, "extract").mockResolvedValue(none),
    spyOn(mods.index, "reindex").mockResolvedValue(undefined as never),
    spyOn(mods.repos, "mapRepos").mockResolvedValue({ failed: 0 } as never),
    spyOn(mods.contacts, "writeContactPeople").mockReturnValue(
      undefined as never
    ),
    spyOn(mods.recorded, "writeRecordedDays").mockRejectedValue(stopped),
    spyOn(mods.models, "isOnline").mockResolvedValue(false),
  ];
  const work = spyOn(mods.matters, "readMatterWork").mockResolvedValue(null);
  try {
    // The backfill's run: no matters.
    await runProcessing("memory.backfill", {
      from: "2026-10-01",
      to: "2026-10-07",
    });
    expect(work).not.toHaveBeenCalled();
    // The night's run: matters, given the sources that failed, after extraction.
    await runNight(7, new Date("2026-11-05T03:00:00Z"), "2026-11-05", true);
    expect(work).toHaveBeenCalledTimes(1);
    expect(work.mock.calls[0]?.[2]).toEqual(["mail"]);
  } finally {
    work.mockRestore();
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
});
