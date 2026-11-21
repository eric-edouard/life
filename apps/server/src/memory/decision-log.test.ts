import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { clock, DAY } from "../core/clock";
import { logEvents, logFileOf } from "../core/log";
import { answerDecision, DECISIONS, requestDecision } from "./decisions";

afterEach(() => rmSync(DECISIONS, { force: true }));

const ask = () => ({
  context: "Kit's quote came in at 400 euros.",
  deadline: new Date(clock().getTime() + 2 * DAY).toISOString(),
  links: ["https://example.com/session/1"],
  onSilence: "wait",
  options: [
    { id: "yes", label: "Book Kit" },
    { id: "wait", label: "Wait for a second quote" },
  ],
  question: "Book Kit to fix the boiler?",
  title: "Fix the boiler",
});

test("a card asked, answered or withdrawn is one log line each: ids and counts, never its words", async () => {
  const answered = await requestDecision("planner", ask());
  await answerDecision(answered.id, ["yes"], "Kit is fine");
  const withdrawn = await requestDecision("planner", ask());
  await requestDecision("planner", {
    why: "Kit cancelled",
    withdraw: withdrawn.id,
  });
  const lines = logEvents(logFileOf(clock().toISOString()), "decision.").filter(
    (l) => l.id === answered.id || l.id === withdrawn.id
  );
  expect(lines).toMatchObject([
    { asker: "planner", draft: false, id: answered.id, kind: "decision.asked" },
    { id: answered.id, kind: "decision.answered", note: true, options: 1 },
    { id: withdrawn.id, kind: "decision.asked" },
    { by: "asker", id: withdrawn.id, kind: "decision.withdrawn" },
  ]);
  expect(JSON.stringify(lines)).not.toContain("Kit");
});
