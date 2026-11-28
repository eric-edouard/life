import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeSetting,
  readSettings,
  SettingChange,
  Settings,
  setSettings,
  settings,
} from "./settings";

test("a corrupt settings file throws instead of switching engine; a missing one is every default, and no engine", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-settings-")), "s.json");
  expect(readSettings(path)).toEqual({
    agentReportSenders: [],
    memoryLanguage: "English",
    sources: [],
  });
  writeFileSync(path, '{"engine": "co');
  expect(() => readSettings(path)).toThrow();
});

test("setSettings changes one part and keeps the others", () => {
  const before = readSettings();
  try {
    setSettings({ engine: "codex" });
    expect(readSettings()).toEqual({ ...before, engine: "codex" });
    expect(settings().engine).toBe("codex");
  } finally {
    setSettings({ engine: before.engine });
  }
});

test("settings set with one bad part writes nothing", () => {
  const before = readSettings();
  expect(() =>
    setSettings({ engine: "codex", sources: ["nowhere"] as never })
  ).toThrow();
  expect(readSettings()).toEqual(before);
});

test("the historical engine is optional and strict, independent of the ordinary engine", () => {
  expect(
    Settings.parse({ engine: "openrouter" }).backfillEngine
  ).toBeUndefined();
  expect(
    Settings.parse({ backfillEngine: "codex", engine: "openrouter" })
  ).toMatchObject({
    backfillEngine: "codex",
    engine: "openrouter",
  });
  expect(Settings.safeParse({ backfillEngine: "unknown" }).success).toBe(false);
  expect(
    Settings.safeParse({ backfillEngine: "codex", inferred: true }).success
  ).toBe(false);
});

test("the renamed settings parse, and the old names are refused", () => {
  const renamed = {
    appointmentsCalendar: { account: "a@example.com", calendar: "Life" },
    deviceNames: {},
    pastCalendar: { calendar: "Past" },
    personal: { histories: { from: "2025-01" }, personas: {} },
    reposFolder: "~/Work",
    sources: ["told-life"],
    todoList: { backend: "reminders" },
  };
  expect(() => Settings.parse(renamed)).not.toThrow();
  for (const old of ["todo_list", "repos", "past", "history", "devices"]) {
    expect(() => Settings.parse({ [old]: renamed.todoList })).toThrow();
  }
});

test("the desk's hand-out is off when absent and strict when set", () => {
  const handOut = (h: object) => Settings.safeParse({ desk: { handOut: h } });
  expect(Settings.safeParse({ desk: {} }).data?.desk?.handOut).toBeUndefined();
  expect(handOut({ aDay: 3, cardsWaiting: 5 }).success).toBe(true);
  expect(handOut({ aDay: 3 }).success).toBe(false);
  expect(handOut({ aDay: 0, cardsWaiting: 5 }).success).toBe(false);
  expect(handOut({ aDay: 3, cardsWaiting: 5, more: 1 }).success).toBe(false);
});

test("his change_setting writes the monthly amount and keeps every other part; nothing else, and no amount of zero, is taken", () => {
  const before = readSettings();
  try {
    expect(changeSetting({ monthlyUsd: 40 }).budget).toEqual({
      monthlyUsd: 40,
    });
    const { budget, ...rest } = readSettings();
    expect(budget).toEqual({ monthlyUsd: 40 });
    expect(rest).toEqual(before);
  } finally {
    setSettings({ budget: null });
  }
  expect(SettingChange.safeParse({ monthlyUsd: 0 }).success).toBe(false);
  expect(
    SettingChange.safeParse({ engine: "codex", monthlyUsd: 5 }).success
  ).toBe(false);
});

/** Today's edge, as the phone's `AuraSetting.standard` holds it. */
const light = (seconds: number, gain: number, clockwise = true) => ({
  clockwise,
  end: 0.33,
  gain,
  opacity: 0.6,
  peak: 0.15,
  seconds,
});
const state = (speed: number, brightness: number, glow: number) => ({
  blur: glow,
  brightness,
  colour: 0,
  glow,
  lights: 0.9,
  pool: 0,
  speed,
});
const AURA: NonNullable<Settings["aura"]> = {
  arc: { ...light(5, 1), end: 0.38, peak: 0.17 },
  colour: 0,
  glowOpacity: 0.7,
  lights: [light(18, 2.8), light(27, 2.2, false)],
  line: { opacity: 1, width: 1 },
  poolRadius: 220,
  rings: { calm: 0.4, work: 0.5 },
  states: {
    rest: state(1, 0.35, 9.5),
    speaking: { ...state(1.825, 0.5, 16), lights: 1, pool: 0.2625 },
    still: state(0, 0.175, 9.5),
    working: { ...state(2, 0.93, 22), colour: 1, lights: 0 },
  },
};

test("his halo settings are saved whole beside his amount; a value past its safe range, a light that ends before it peaks, an unknown knob or an empty change is refused", () => {
  const before = readSettings();
  try {
    expect(changeSetting({ aura: AURA }).aura).toEqual(AURA);
    // A change of the amount keeps the aura.
    expect(changeSetting({ monthlyUsd: 40 }).aura).toEqual(AURA);
    const { aura, budget, ...rest } = readSettings();
    expect(aura).toEqual(AURA);
    expect(rest).toEqual(before);
  } finally {
    setSettings({ aura: null, budget: null });
  }
  const refused = (aura: unknown) =>
    expect(SettingChange.safeParse({ aura }).success).toBe(false);
  refused({ ...AURA, line: { opacity: 1, width: 9 } });
  refused({ ...AURA, arc: { ...AURA.arc, peak: 0.5 } });
  refused({ ...AURA, colour: 10 });
  refused({ ...AURA, wobble: 1 });
  refused({ ...AURA, states: { ...AURA.states, still: undefined } });
  expect(() => changeSetting({})).toThrow("Not done");
});
