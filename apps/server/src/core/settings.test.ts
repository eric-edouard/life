import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, Settings, setSettings, settings } from "./settings";

test("a corrupt settings file throws instead of switching engine; a missing one is every default", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-settings-")), "s.json");
  expect(readSettings(path)).toEqual({
    agentReportSenders: [],
    engine: "claude",
    memoryLanguage: "English",
    notifications: {},
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

test("his notification settings name only known kinds and levels", () => {
  expect(Settings.safeParse({ notifications: { voice: "off" } }).success).toBe(
    true
  );
  expect(Settings.safeParse({ notifications: { calls: "off" } }).success).toBe(
    false
  );
  expect(Settings.safeParse({ notifications: { voice: "loud" } }).success).toBe(
    false
  );
});

test("the desk's hand-out is off when absent and strict when set", () => {
  const handOut = (h: object) => Settings.safeParse({ desk: { handOut: h } });
  expect(Settings.safeParse({ desk: {} }).data?.desk?.handOut).toBeUndefined();
  expect(handOut({ aDay: 3, cardsWaiting: 5 }).success).toBe(true);
  expect(handOut({ aDay: 3 }).success).toBe(false);
  expect(handOut({ aDay: 0, cardsWaiting: 5 }).success).toBe(false);
  expect(handOut({ aDay: 3, cardsWaiting: 5, more: 1 }).success).toBe(false);
});
