import { beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DAY, HOUR } from "../core/clock";
import {
  answerDecision,
  DECISIONS,
  decisionsNow,
  pushDueOf,
  requestDecision,
} from "./decisions";

const DECISION_ID = /^dec_[0-9a-f]{12}$/;
const NOW = new Date("2026-11-18T09:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const ask = (over = {}) => ({
  context: "Kit's quote came in at 400 euros.",
  deadline: later(2 * DAY).toISOString(),
  links: ["https://example.com/session/1"],
  onSilence: "wait",
  options: [
    { id: "yes", label: "Book Kit" },
    { id: "wait", label: "Wait for a second quote" },
  ],
  question: "Book Kit to fix the boiler?",
  recommended: ["yes"],
  why: "Cheapest of the three he asked around.",
  ...over,
});
const stateOf = (id: string, at = NOW) =>
  decisionsNow(at).find((d) => d.id === id)?.state;

beforeEach(() => rmSync(DECISIONS, { force: true }));

test("a decision is open until its deadline, then lapsed; an answer after it is refused", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  expect(id).toMatch(DECISION_ID);
  expect(stateOf(id)).toBe("open");
  expect(stateOf(id, later(2 * DAY))).toBe("lapsed");
  expect(() => answerDecision(id, ["yes"], undefined, later(3 * DAY))).toThrow(
    "lapsed"
  );
});

test("the first answer stands; a second is refused", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  answerDecision(id, ["yes"], undefined, later(HOUR));
  expect(() =>
    answerDecision(id, ["wait"], undefined, later(2 * HOUR))
  ).toThrow("answered");
  const [d] = decisionsNow(later(3 * DAY));
  expect(d?.state).toBe("answered");
  expect(d?.answer?.options).toEqual(["yes"]);
});

test("an answer is option ids, or none with his words; an unknown option is refused", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  expect(() => answerDecision(id, ["maybe"], undefined, NOW)).toThrow("maybe");
  expect(() => answerDecision(id, [], undefined, NOW)).toThrow("note");
  answerDecision(id, [], "Ask Ana first", NOW);
  expect(decisionsNow(NOW)[0]?.answer?.note).toBe("Ask Ana first");
});

test("only its asker withdraws a decision, while it is open", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  await expect(
    requestDecision("other", { why: "done", withdraw: id }, NOW)
  ).rejects.toThrow("another agent");
  await requestDecision("planner", { why: "Kit cancelled", withdraw: id }, NOW);
  expect(stateOf(id)).toBe("withdrawn");
  expect(() => answerDecision(id, ["yes"], undefined, NOW)).toThrow(
    "withdrawn"
  );
});

test("a request is checked: deadline 1 hour to 14 days ahead, options its ids, a step only of an open matter", async () => {
  const refused = (over: object) =>
    expect(requestDecision("planner", ask(over), NOW)).rejects.toThrow(
      "Not done"
    );
  await refused({ deadline: later(30 * 60_000).toISOString() });
  await refused({ deadline: later(15 * DAY).toISOString() });
  await refused({ recommended: ["maybe"] });
  await refused({ onSilence: "maybe" });
  await refused({ options: [{ id: "yes", label: "Yes" }] });
  await refused({ subject: "obs_000000000001" });
  await requestDecision("planner", ask({ subject: "project:boiler" }), NOW);
  await requestDecision("planner", ask({ onSilence: null }), NOW);
  expect(decisionsNow(NOW)).toHaveLength(2);
});

test("the old decisions page's lines in the file are skipped", async () => {
  mkdirSync(dirname(DECISIONS), { recursive: true });
  appendFileSync(
    DECISIONS,
    `${JSON.stringify({ at: NOW.toISOString(), data: {}, decision: "daily-1", schemaVersion: 1, step: "asked" })}\n`
  );
  const { id } = await requestDecision("planner", ask(), NOW);
  expect(decisionsNow(NOW).map((d) => d.id)).toEqual([id]);
});

test("a decision is pushed once, as its deadline comes within 24 hours, or at once when it already has", async () => {
  await requestDecision("planner", ask(), NOW);
  await requestDecision(
    "planner",
    ask({ deadline: later(3 * HOUR).toISOString() }),
    NOW
  );
  const ids = decisionsNow(NOW).map((d) => d.id);
  const due = (from: Date, to: Date) =>
    pushDueOf(decisionsNow(to), from, to).map((d) => d.id);
  expect(due(later(-60_000), NOW)).toEqual(ids.slice(1));
  expect(due(NOW, later(DAY - 60_000))).toEqual([]);
  expect(due(later(DAY - 60_000), later(DAY))).toEqual(ids.slice(0, 1));
  expect(due(later(DAY), later(DAY + 60_000))).toEqual([]);
});
