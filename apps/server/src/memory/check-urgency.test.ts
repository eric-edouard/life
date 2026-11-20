import { expect, test } from "bun:test";
import {
  blockingCountOf,
  inboxOrderOf,
  inboxRankOf,
  urgencyOf,
} from "./check-urgency";

const check = (group: string, subject: string | null = null) =>
  ({ group, subject }) as never;

test("by kind: decision, unnamed voice, name and card together (these block), then a guess in use, a new matter, an ending", () => {
  const list = [
    check("decision"),
    check("voice"),
    check("name"),
    check("contacts card"),
    check("guessed person"),
    check("voice", "person:gran"),
    check("new matter"),
    check("ending"),
  ];
  expect(list.map(inboxRankOf)).toEqual([0, 1, 1, 1, 2, 2, 3, 4]);
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
  expect(blockingCountOf(list)).toBe(4);
});

const ask = (
  ref: string,
  group: string,
  more: {
    day?: string;
    deadline?: string;
    matter?: string;
    matterIds?: string[];
    matters?: number;
    observations?: number;
  } = {}
) =>
  ({
    day: more.day ?? "2026-11-01",
    deadline: more.deadline ?? null,
    group,
    matter: more.matter ? { id: more.matter } : null,
    ref,
    ridesOn: {
      matterIds: more.matterIds ?? [],
      matters: more.matters ?? 0,
      observations: more.observations ?? 0,
      pages: 0,
    },
    subject: null,
  }) as never;

test("the order: deadlines soonest first, decisions oldest first, unnamed asks by matters then newest; then guesses, offers, endings; a matter's asks together", () => {
  const order = inboxOrderOf([
    ask("ending", "ending"),
    ask("offer", "new matter"),
    ask("guess-many-lines", "guessed person", { observations: 3 }),
    ask("guess-one-matter", "guessed person", { matters: 1 }),
    ask("name-new", "name", { day: "2026-11-05" }),
    ask("voice-old", "voice", { day: "2026-11-02" }),
    ask("card-on-matter", "contacts card", { matter: "m1", matters: 2 }),
    ask("decision-new", "decision", { day: "2026-11-03" }),
    ask("decision-old", "decision", { day: "2026-11-01" }),
    ask("due-late", "decision", { deadline: "2026-11-09" }),
    ask("due-soon", "decision", { deadline: "2026-11-07" }),
    // Of m1, sorted last of its group: it moves up behind m1's first ask.
    ask("voice-on-m1", "voice", { day: "2026-10-01", matter: "m1" }),
    // No matter of its own, but it rides on m1: it joins m1's asks too.
    ask("name-rides-m1", "name", { day: "2026-10-02", matterIds: ["m1"] }),
    // Of m1 too, but it improves: it stays with what improves.
    ask("offer-on-m1", "new matter", { matter: "m1" }),
  ]).map((c: { ref: string }) => c.ref);
  expect(order).toEqual([
    "due-soon",
    "due-late",
    "decision-old",
    "decision-new",
    "card-on-matter",
    "name-rides-m1",
    "voice-on-m1",
    "name-new",
    "voice-old",
    "guess-one-matter",
    "guess-many-lines",
    "offer",
    "offer-on-m1",
    "ending",
  ]);
});
