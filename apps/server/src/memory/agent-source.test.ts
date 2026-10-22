import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { appendJsonl } from "../core/files";
import { AGENT_WORD } from "../core/names";
import { LedgerEntry } from "../records/ledger-entry";
import { KEEP_AT } from "../records/unit";
import { newestAgent, readAgent } from "./agent-source";
import { LEDGER } from "./ledger";
import { importanceOf } from "./moments";
import { action } from "./record-fixtures";
import { messageUnits } from "./units";
import { chatLines } from "./words";

const NON_DIGIT = /\D/g;

afterAll(() => rmSync(LEDGER, { force: true }));

const ask = (id: string, quote: string) =>
  action({
    after: { confidence: "high" },
    id,
    instruction: { at: "2026-10-20T14:50:00.000Z", quote, ref: `job-1:${id}` },
    kind: "ask",
    target: AGENT_WORD,
    via: "watch",
  });
const update = (task: string, at: string, after: Record<string, unknown>) =>
  action({
    after,
    at,
    id: `entry_${at.replace(NON_DIGIT, "").slice(2, 14)}`,
    kind: "update",
    target: task,
    via: "connector",
  });

test("a task Orbit closed done is one event: its outcome with his ask's words, Orbit's report, never his", () => {
  mkdirSync(dirname(LEDGER), { recursive: true });
  rmSync(LEDGER, { force: true });
  appendJsonl(LEDGER, LedgerEntry, [
    ask("entry_aaaaaaaaaaaa", "hey Orbit, find the plumber's number"),
    update("entry_aaaaaaaaaaaa", "2026-10-20T14:52:00.000Z", {
      state: "working",
      taken: true,
    }),
    update("entry_aaaaaaaaaaaa", "2026-10-20T14:55:00.000Z", {
      outcome: "Found it: +66 600 000 001",
      state: "done",
    }),
    // Still working, and done before the window: none.
    ask("entry_bbbbbbbbbbbb", "hey Orbit, book the train"),
    update("entry_bbbbbbbbbbbb", "2026-10-20T15:00:00.000Z", {
      state: "working",
      taken: true,
    }),
    ask("entry_cccccccccccc", "hey Orbit, an old one"),
    update("entry_cccccccccccc", "2026-10-01T10:00:00.000Z", {
      outcome: "done long ago",
      state: "done",
    }),
    // He ticked its receipt in Reminders: his tick, not Orbit's report of work done.
    ask("entry_dddddddddddd", "hey Orbit, call the bank"),
    {
      ...update("entry_dddddddddddd", "2026-10-20T16:00:00.000Z", {
        outcome: "he ticked its receipt in Reminders",
        state: "done",
      }),
      via: "reminders",
    },
  ]);
  expect(newestAgent().at).toBe("2026-10-20T14:55:00.000Z");
  const events = readAgent(new Date("2026-10-14T00:00:00.000Z"));
  expect(events.map((e) => [e.id, e.at, e.sender, e.fromMe])).toEqual([
    [
      `${AGENT_WORD}:entry_aaaaaaaaaaaa`,
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
  // Always read for what it may close: its importance never falls under KEEP_AT.
  expect(unit && importanceOf(unit.unit, 0)).toBe(KEEP_AT);
});
