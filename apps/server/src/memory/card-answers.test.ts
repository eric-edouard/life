import { beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import { answerIconOf } from "../records/answer-icon";
import { DECISIONS } from "./decision-lines";
import { decisionsNow, requestDecision } from "./decisions";

// A card's answers: one rule for every agent's card (`answersProblemOf`, `card-problems.ts`) and its icons (`answerIconOf`).

const NOW = new Date("2026-11-18T09:00:00.000Z");
const ask = (over = {}) => ({
  context: "Kit's quote came in at 400 euros.",
  deadline: new Date(NOW.getTime() + 2 * DAY).toISOString(),
  links: [],
  onSilence: null,
  options: [
    { id: "yes", label: "Book Kit" },
    { id: "wait", label: "Wait" },
  ],
  question: "Book Kit to fix the boiler?",
  title: "Fix the boiler",
  ...over,
});

beforeEach(() => rmSync(DECISIONS, { force: true }));

test("a card's answers follow one rule: 2 or 3 options, the later ones short, no repeat, no second Tell, no agent control, no icon of Life's acts", async () => {
  const refused = (options: object[], why: string) =>
    expect(
      requestDecision("planner", ask({ onSilence: null, options }), NOW)
    ).rejects.toThrow(why);
  const book = { id: "yes", label: "Book Kit" };
  await refused(
    [
      book,
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    "at most 3 options"
  );
  await refused(
    [book, { id: "w", label: "Wait for a second quote" }],
    "14 characters"
  );
  await refused([book, { id: "again", label: "book kit" }], "labels repeat");
  await refused(
    [book, { id: "tell", label: "Tell the agent…", takes: "note" }],
    "Tell the agent"
  );
  await refused(
    [book, { id: "stop", label: "Stop the agent" }],
    "controls the agent"
  );
  await refused(
    [
      { ...book, icon: "send" },
      { id: "w", label: "Wait" },
    ],
    "are Life's"
  );
  await refused(
    [
      { ...book, icon: "date", outgoing: true },
      { id: "w", label: "Wait" },
    ],
    "Life draws its own"
  );
  await refused(
    [book, { ends: "matter", icon: "later", id: "d", label: "Not now" }],
    "an `ends` option closes"
  );
  // A fair label that starts with "Tell" and an agent's own icon pass.
  const { id } = await requestDecision(
    "planner",
    ask({
      onSilence: null,
      options: [
        { ...book, icon: "date" },
        { icon: "no", id: "tell", label: "Tell Kit no" },
      ],
    }),
    NOW
  );
  expect(decisionsNow(NOW).find((d) => d.id === id)?.options[0]?.icon).toBe(
    "date"
  );
});

test("an answer's icon: Life's act where Life acts, else the one given, else done on an ending option", () => {
  expect(answerIconOf({ icon: "date", outgoing: true })).toBe("send");
  expect(answerIconOf({ adds: true })).toBe("add_to_calendar");
  expect(answerIconOf({ looks: true })).toBe("done");
  expect(answerIconOf({ ends: "matter", icon: "drop" })).toBe("drop");
  expect(answerIconOf({ ends: "step" })).toBe("done");
  expect(answerIconOf({})).toBeUndefined();
});
