import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { action } from "../memory/fixtures";
import { ACTIONS, appendJsonl } from "../memory/ledger";
import { saliencyOf } from "../memory/moments";
import { chatLines } from "../memory/raw";
import { messageUnits } from "../memory/units";
import { Action, KEEP_AT } from "../schema";
import { readAtlas } from "./atlas";

const NON_DIGIT = /\D/g;

afterAll(() => rmSync(ACTIONS, { force: true }));

const ask = (id: string, quote: string) =>
  action({
    after: { confidence: "high" },
    id,
    instruction: { at: "2026-10-20T14:50:00.000Z", quote, ref: `job-1:${id}` },
    kind: "ask",
    madeBy: "watch",
    target: "atlas",
  });
const update = (task: string, at: string, after: Record<string, unknown>) =>
  action({
    after,
    at,
    id: `act_${at.replace(NON_DIGIT, "").slice(2, 14)}`,
    kind: "update",
    madeBy: "connector",
    target: task,
  });

test("a task Atlas closed done is one event: its outcome with his ask's words, Atlas's report, never his", () => {
  mkdirSync(dirname(ACTIONS), { recursive: true });
  rmSync(ACTIONS, { force: true });
  appendJsonl(ACTIONS, Action, [
    ask("act_aaaaaaaaaaaa", "hey Atlas, find the plumber's number"),
    update("act_aaaaaaaaaaaa", "2026-10-20T14:52:00.000Z", {
      claim: true,
      state: "working",
    }),
    update("act_aaaaaaaaaaaa", "2026-10-20T14:55:00.000Z", {
      outcome: "Found it: +66 600 000 001",
      state: "done",
    }),
    // Still working, and done before the window: none.
    ask("act_bbbbbbbbbbbb", "hey Atlas, book the train"),
    update("act_bbbbbbbbbbbb", "2026-10-20T15:00:00.000Z", {
      claim: true,
      state: "working",
    }),
    ask("act_cccccccccccc", "hey Atlas, an old one"),
    update("act_cccccccccccc", "2026-10-01T10:00:00.000Z", {
      outcome: "done long ago",
      state: "done",
    }),
  ]);
  const events = readAtlas(new Date("2026-10-14T00:00:00.000Z"));
  expect(events.map((e) => [e.id, e.at, e.sender, e.fromMe])).toEqual([
    ["atlas:act_aaaaaaaaaaaa", "2026-10-20T14:55:00.000Z", "atlas", false],
  ]);
  expect(events[0]?.text).toContain("not his words");
  expect(events[0]?.text).toContain(`"hey Atlas, find the plumber's number"`);
  expect(events[0]?.text).toContain("Outcome: Found it: +66 600 000 001");
  // Its unit names no one: Atlas is no person, and his ask is quoted inside Atlas's report.
  const [unit] = messageUnits(events, () => null);
  expect([unit?.unit.source, unit?.unit.people]).toEqual(["atlas", []]);
  // Its line is the agent's, never resolved to a person (not even one named Atlas), so never read as his.
  const [line] = unit ? chatLines(unit, () => "person:atlas-the-plumber") : [];
  expect([line?.speaker, line?.from]).toEqual(["agent:atlas", undefined]);
  // Always read for what it may close: its salience never falls under KEEP_AT.
  expect(unit && saliencyOf(unit.unit, 0)).toBe(KEEP_AT);
});
