import { expect, test } from "bun:test";
import { blockingOf, inboxRankOf, urgencyOf } from "./check-urgency";

const check = (group: string, likelyPeople: unknown[] = []) =>
  ({ group, likelyPeople }) as never;

test("the inbox runs decision, unnamed voice, unplaced name or card, then new matter, guesses in use, endings; the first three block", () => {
  const list = [
    check("decision"),
    check("voice"),
    check("name"),
    check("contacts card"),
    check("new matter"),
    check("guessed person"),
    check("voice", [{}]),
    check("ending"),
  ];
  expect(list.map(inboxRankOf)).toEqual([0, 1, 2, 2, 3, 4, 4, 5]);
  expect(list.map(urgencyOf)).toEqual([
    "blocks",
    "blocks",
    "blocks",
    "blocks",
    "improves",
    "improves",
    "improves",
    "improves",
  ]);
  expect(blockingOf(list)).toBe(4);
});
