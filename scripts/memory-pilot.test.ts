import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR } from "@life/server/src/core/clock";
import { MEMORY } from "@life/server/src/memory/memory-files";
import type { SourceEvent } from "@life/server/src/records/source";
import { earlierOf, folderOf, KEPT, trialDir, trialPath } from "./memory-pilot";

const START = Date.parse("2026-10-01T12:00:00.000Z");
const at = (ms: number, chat = "room"): SourceEvent => ({
  at: new Date(START + ms).toISOString(),
  chat,
  fromMe: false,
  id: `${chat}:${ms}`,
  sender: "Ana",
  source: "whatsapp",
  text: "hello",
});

test("a trial writes only under the pilot's folder: a label that leaves it, or reaches the night's memory, is refused", () => {
  expect(trialDir("mentions", "b1-high", "text")).toStartWith(KEPT);
  expect(() =>
    trialDir("mentions", "../../../../memory/read-replies", "x")
  ).toThrow();
  expect(() => trialDir("mentions", "../../..", "x")).toThrow();
  expect(() => trialPath(["mentions", ".."])).toThrow();
  expect(() => trialPath([], KEPT)).toThrow();
  // Even a pilot folder kept inside memory/ is refused.
  expect(() => trialPath(["mentions", "a"], join(MEMORY, "pilot"))).toThrow();
  expect(() => trialPath(["mentions", "a"], KEPT, KEPT)).toThrow();
});

test("a folder is found by its label or its full name; none or several is an error listing them", () => {
  const root = mkdtempSync(join(tmpdir(), "pilot-"));
  try {
    for (const name of [
      `a-${"1".repeat(16)}`,
      `a-${"2".repeat(16)}`,
      `b-${"3".repeat(16)}`,
    ]) {
      mkdirSync(join(root, "mentions", name), { recursive: true });
    }
    expect(folderOf("mentions", "b", root)).toBe(
      join(root, "mentions", `b-${"3".repeat(16)}`)
    );
    expect(folderOf("mentions", `a-${"2".repeat(16)}`, root)).toBe(
      join(root, "mentions", `a-${"2".repeat(16)}`)
    );
    // A stray file is no trial folder.
    writeFileSync(join(root, "mentions", ".DS_Store"), "x");
    expect(() => folderOf("mentions", "a", root)).toThrow("2 folders");
    expect(() => folderOf("mentions", "c", root)).toThrow("0 folders");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a call's earlier lines are the set's messages of its chat before it that are one exchange with it", () => {
  const whole = [
    at(0),
    at(60_000),
    at(8 * HOUR),
    at(0, "other"),
    at(8 * HOUR + 1000),
    at(8 * HOUR + 60_000),
  ];
  // The batch starts at the 5th message; the 8-hour-old pair is another exchange, and the other chat is no one's.
  expect(earlierOf([[at(8 * HOUR + 60_000)]], whole).map((e) => e.id)).toEqual([
    "room:28800000",
    "room:28801000",
  ]);
  expect(earlierOf([[at(60_000)]], whole).map((e) => e.id)).toEqual(["room:0"]);
  expect(earlierOf([[at(0, "other")]], whole)).toEqual([]);
  expect(earlierOf([], whole)).toEqual([]);
});
