import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { appendJsonl } from "../core/files";
import { AGENT_WORD } from "../core/names";
import { action } from "../memory/fixtures";
import { ACTIONS } from "../memory/ledger";
import { saliencyOf } from "../memory/moments";
import { chatLines } from "../memory/raw";
import { messageUnits } from "../memory/units";
import { Action } from "../records/ledger";
import { KEEP_AT } from "../records/observations";
import { newestAgent, readAgent } from "./agent";

const NON_DIGIT = /\D/g;

afterAll(() => rmSync(ACTIONS, { force: true }));

const ask = (id: string, quote: string) =>
  action({
    after: { confidence: "high" },
    id,
    instruction: { at: "2026-10-20T14:50:00.000Z", quote, ref: `job-1:${id}` },
    kind: "ask",
    madeBy: "watch",
    target: AGENT_WORD,
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

test("a task Orbit closed done is one event: its outcome with his ask's words, Orbit's report, never his", () => {
  mkdirSync(dirname(ACTIONS), { recursive: true });
  rmSync(ACTIONS, { force: true });
  appendJsonl(ACTIONS, Action, [
    ask("act_aaaaaaaaaaaa", "hey Orbit, find the plumber's number"),
    update("act_aaaaaaaaaaaa", "2026-10-20T14:52:00.000Z", {
      claim: true,
      state: "working",
    }),
    update("act_aaaaaaaaaaaa", "2026-10-20T14:55:00.000Z", {
      outcome: "Found it: +66 600 000 001",
      state: "done",
    }),
    // Still working, and done before the window: none.
    ask("act_bbbbbbbbbbbb", "hey Orbit, book the train"),
    update("act_bbbbbbbbbbbb", "2026-10-20T15:00:00.000Z", {
      claim: true,
      state: "working",
    }),
    ask("act_cccccccccccc", "hey Orbit, an old one"),
    update("act_cccccccccccc", "2026-10-01T10:00:00.000Z", {
      outcome: "done long ago",
      state: "done",
    }),
    // He ticked its receipt in Reminders: his tick, not Orbit's report of work done.
    ask("act_dddddddddddd", "hey Orbit, call the bank"),
    {
      ...update("act_dddddddddddd", "2026-10-20T16:00:00.000Z", {
        outcome: "he ticked its receipt in Reminders",
        state: "done",
      }),
      madeBy: "reminders",
    },
  ]);
  expect(newestAgent().at).toBe("2026-10-20T14:55:00.000Z");
  const events = readAgent(new Date("2026-10-14T00:00:00.000Z"));
  expect(events.map((e) => [e.id, e.at, e.sender, e.fromMe])).toEqual([
    [
      `${AGENT_WORD}:act_aaaaaaaaaaaa`,
      "2026-10-20T14:55:00.000Z",
      AGENT_WORD,
      false,
    ],
  ]);
  expect(events[0]?.text).toContain("not his words");
  expect(events[0]?.text).toContain(`"hey Orbit, find the plumber's number"`);
  expect(events[0]?.text).toContain("Outcome: Found it: +66 600 000 001");
  // Its unit names no one: Orbit is no person, and his ask is quoted inside Orbit's report.
  const [unit] = messageUnits(events, () => null);
  expect([unit?.unit.source, unit?.unit.people]).toEqual([AGENT_WORD, []]);
  // Its line is the agent's, never resolved to a person (not even one named Orbit), so never read as his.
  const named = () => "person:orbit-the-plumber";
  const [line] = unit ? chatLines(unit, named) : [];
  expect(messageUnits(events, named)[0]?.text).not.toContain(
    "orbit-the-plumber"
  );
  expect([line?.speaker, line?.from]).toEqual([
    `agent:${AGENT_WORD}`,
    undefined,
  ]);
  // Always read for what it may close: its salience never falls under KEEP_AT.
  expect(unit && saliencyOf(unit.unit, 0)).toBe(KEEP_AT);
});
