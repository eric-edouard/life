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
import { setSettings, settings } from "../core/settings";
import { OUT, standingReadings } from "../memory/memory-files";
import { unit } from "../memory/record-fixtures";
import type { Extracted, Observation } from "../records/observation";
import {
  dropOld,
  markedSince,
  nightly,
  readChecksFor,
  readSpokenConversations,
  runNight,
} from "./nightly";

test("each marked unit is listed once read since the last night, with the observations citing its marked lines", () => {
  const u = unit({ marked: ["j:1@a", "j:2@a"] });
  const built = [
    { messages: [], text: "", unit: u },
    { messages: [], text: "", unit: unit({ id: "unit_000000000002" }) },
  ];
  const read = (at: string, id = u.id, unitHash = u.hash) =>
    ({ at, unit: id, unitHash }) as Extracted;
  const latest = (...lines: Extracted[]) => standingReadings(lines);
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

test("the night places matters after extraction, with the evidence's failed sources", async () => {
  const stopped = new Error("stopped after matters");
  const mods = {
    contacts: await import("../memory/contact-people"),
    episodes: await import("../memory/episodes"),
    extract: await import("../memory/extract"),
    gather: await import("../memory/gather"),
    index: await import("../memory/index-writer"),
    matters: await import("../memory/matters"),
    models: await import("../models/llm"),
    recorded: await import("../memory/recorded-days"),
    repos: await import("../memory/repos"),
    settings: await import("../core/settings"),
    who: await import("../memory/who"),
    writer: await import("../memory/unit-writer"),
  };
  const none = { failed: 0 } as never;
  const gathered = spyOn(mods.gather, "gather").mockResolvedValue({
    failed: ["mail"],
  } as never);
  const published = spyOn(mods.writer, "publishUnits").mockResolvedValue(
    undefined as never
  );
  const spies = [
    spyOn(mods.settings, "settings").mockReturnValue({
      engine: "claude",
    } as never),
    spyOn(mods.who, "readPeople").mockResolvedValue({} as never),
    gathered,
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
  const records = spyOn(mods.matters, "readMatterRecords").mockResolvedValue(
    {} as never
  );
  try {
    // Matters, given the sources that failed, after extraction.
    await runNight(7, new Date("2026-11-05T03:00:00Z"), "2026-11-05", true);
    expect(work).toHaveBeenCalledTimes(1);
    expect(work.mock.calls[0]?.[2]).toEqual(["mail"]);
    // A source failed: no units are published.
    expect(published).not.toHaveBeenCalled();
    // None failed: the night publishes the units, then the episodes step reads the days.
    gathered.mockResolvedValue({ failed: [] } as never);
    await runNight(7, new Date("2026-11-05T03:00:00Z"), "2026-11-05", true);
    expect(published).toHaveBeenCalledTimes(1);
    expect(published.mock.invocationCallOrder[0]).toBeLessThan(
      (
        mods.episodes.episodes as unknown as {
          mock: { invocationCallOrder: number[] };
        }
      ).mock.invocationCallOrder.at(-1) as number
    );
  } finally {
    published.mockRestore();
    work.mockRestore();
    records.mockRestore();
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
});

test("checks that cannot be read are logged and the report has none: the night is not failed", async () => {
  const mods = await import("../memory/checks");
  const broke = spyOn(mods, "checksNow").mockRejectedValue(new Error("boom"));
  const errors: [string, unknown][] = [];
  try {
    const list = await readChecksFor({
      error: (e: Error, extra?: unknown) => {
        errors.push([e.message, extra]);
      },
    } as never);
    expect(list).toEqual([]);
    expect(errors).toEqual([["boom", { step: "memory.nightly.checks" }]]);
  } finally {
    broke.mockRestore();
  }
});

// His word of 16 Nov 2026: "is this done?" is load. The email never asks an ending check; every other check stays.
test("the report's checks leave out the ending checks, keep every other one", async () => {
  const mods = await import("../memory/checks");
  const of = (kind: "ending" | "person", ref: string) =>
    ({ guess: ref, kind, ref }) as never;
  const listed = spyOn(mods, "checksNow").mockResolvedValue([
    of("ending", "obs_000000000001"),
    of("person", "person:zed"),
  ]);
  try {
    const list = await readChecksFor({ error: () => undefined } as never);
    expect(list.map((c) => c.ref)).toEqual(["person:zed"]);
  } finally {
    listed.mockRestore();
  }
});

test("a voice naming that cannot read lifelog's voices is logged once under its step and the night goes on", async () => {
  const [summaries, naming, who, logs] = await Promise.all([
    import("../memory/conversation-summaries"),
    import("../memory/voice-naming"),
    import("../memory/who"),
    import("../core/log"),
  ]);
  const spies = [
    spyOn(who, "readPeople").mockResolvedValue({} as never),
    spyOn(summaries, "readConversationSummaryWork").mockResolvedValue({
      counts: { conversations: 0, parts: 0 },
      parts: [],
    } as never),
    spyOn(summaries, "conversationSummaries").mockResolvedValue(
      undefined as never
    ),
    spyOn(naming, "readVoiceNamingWork").mockRejectedValue(
      new Error("voice naming needs the new Lifelog Host")
    ),
  ];
  const logged = spyOn(logs, "log").mockImplementation(
    (() => undefined) as never
  );
  const before = settings().voiceNaming;
  setSettings({ voiceNaming: true });
  try {
    await readSpokenConversations(new Date(), []);
    expect(logged.mock.calls).toEqual([
      [
        "run.error",
        {
          error: "voice naming needs the new Lifelog Host",
          step: "memory.voice-naming",
        },
      ],
    ]);
  } finally {
    setSettings({ voiceNaming: before });
    logged.mockRestore();
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
});
