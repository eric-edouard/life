import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { HOUR } from "../core/clock";
import { DECISIONS } from "./decision-lines";
import {
  decisionsNow,
  requestDecision,
  withdrawDeletedCards,
} from "./decisions";

// A card a deletion reaches is withdrawn by Life (docs/glossary.md, "deletion"): nothing is asked from what he deleted.

const NOW = new Date("2026-11-18T09:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

const ask = () => ({
  context: "Kit's quote came in at 400 euros.",
  deadline: later(48 * HOUR).toISOString(),
  links: [],
  onSilence: "wait",
  options: [
    { id: "yes", label: "Book Kit" },
    { id: "wait", label: "Wait" },
  ],
  question: "Book Kit to fix the boiler?",
  title: "Fix the boiler",
});

const stateOf = (id: string) =>
  decisionsNow(NOW).find((d) => d.id === id)?.state;

beforeEach(() => rmSync(DECISIONS, { force: true }));
afterEach(() => setSystemTime());

test("a card a deletion reaches is withdrawn by Life, once: nothing is asked from what he deleted", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  expect(withdrawDeletedCards([id, "dec_0000000000ff"], NOW)).toEqual([id]);
  expect(stateOf(id)).toBe("withdrawn");
  // Nothing left open: a second deletion of the same step writes no line.
  expect(withdrawDeletedCards([id], later(HOUR))).toEqual([]);
});
