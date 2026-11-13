import { expect, test } from "bun:test";
import { moveRateLines } from "./move-rate-lines";
import type { StoredMoveRate } from "./move-rates-file";

const count = (n: number, of: number) => ({ n, of });
const row = (
  thing: string,
  extra: Partial<StoredMoveRate> = {}
): StoredMoveRate => ({
  above: 10,
  all: count(50, 200),
  among: 20,
  before: count(50, 200),
  below: 10,
  lately: count(50, 200),
  says: "share",
  source: undefined,
  thing,
  ...extra,
});
const HEAD =
  '## What stands out between them and him (counted by code from their one-to-one chats; "he" is the owner)';

const person: StoredMoveRate[] = [
  row("tension", {
    above: 1,
    all: count(225, 1423),
    among: 45,
    before: count(130, 1000),
    below: 43,
    lately: count(110, 423),
    source: "whatsapp",
  }),
  row("directs", {
    above: 2,
    all: count(74, 150),
    among: 42,
    below: 39,
    side: "them",
  }),
  row("directs", { all: count(21, 150), side: "me" }),
  row("decides", { all: count(60, 150), side: "them" }),
  row("decides", { all: count(30, 150), side: "me" }),
  ...(
    [
      ["yields", 28, "me"],
      ["engages", 27, "me"],
      ["excuses", 20, "me"],
      ["denies", 15, "me"],
      ["apologises", 8, "me"],
    ] as const
  ).map(([thing, n, side]) =>
    row(thing, {
      all: count(n, 109),
      says: thing === "yields" || thing === "engages" ? "exploratory" : "share",
      side,
    })
  ),
  ...(
    [
      ["apologises", 4],
      ["denies", 5],
      ["excuses", 7],
    ] as const
  ).map(([thing, n]) =>
    row(thing, { all: count(n, 42), says: "exploratory", side: "them" })
  ),
];

test("the sentences: how they steer, what stands out, then the answers to a fault", () => {
  expect(moveRateLines(person)).toEqual([
    HEAD,
    "- Telling the other what to do, when something is decided: they in 49% of those exchanges, he in 14%; only 2 of 42 other people do it more than they do; settling it: they in 40%, he in 20%.",
    "- Some tension: in 16% of their exchanges, more than with all but 1 of 45 other people; 26% in the last 12 months, 13% before.",
    "- When he raised a fault (42 exchanges): they made an excuse in 7, denied in 5, apologised in 4 (raw counts, not proven).",
    "- When they raised a fault (109 exchanges): he yielded in 28, engaged with it in 27, made an excuse in 20, denied in 15, apologised in 8 (raw counts, not proven).",
    "",
  ]);
});

test("unremarkable rows give no more sentences, but the steering one when its chances are met", () => {
  const dull = [
    row("tension", { source: "whatsapp" }),
    row("asks_about", { side: "me", source: "whatsapp" }),
    row("asks_about", { side: "them", source: "whatsapp" }),
    row("directs", { all: count(30, 150), side: "me" }),
    row("directs", { all: count(40, 150), side: "them" }),
  ];
  expect(moveRateLines(dull)).toEqual([
    HEAD,
    "- Telling the other what to do, when something is decided: they in 27% of those exchanges, he in 20%.",
    "",
  ]);
  expect(moveRateLines(dull.slice(0, 3))).toEqual([]);
});

test("no rows, no section; a fault answered by shares only has no raw-counts tail", () => {
  expect(moveRateLines([])).toEqual([]);
  expect(
    moveRateLines([row("denies", { all: count(15, 109), side: "me" })])
  ).toEqual([
    HEAD,
    "- When they raised a fault (109 exchanges): he denied in 15.",
    "",
  ]);
});

test("at most six sentences of what else stands out, the most extreme first", () => {
  const rows = [
    "shares",
    "gives",
    "offers",
    "thanks",
    "invites",
    "feels",
    "wants",
    "intends",
  ].map((thing, i) =>
    row(thing, { above: i % 3, side: "me", source: "whatsapp" })
  );
  const lines = moveRateLines([
    row("tension", { source: "whatsapp" }),
    ...rows,
  ]);
  expect(lines).toHaveLength(8);
  expect(lines[1]).toStartWith(
    "- Sharing something of their day: he in 25%; he more than all but 0 of 20"
  );
  // Of eight at an extreme, the two least extreme go.
  expect(lines.join()).not.toContain("Offering something");
  expect(lines.join()).not.toContain("Saying how they feel");
});
