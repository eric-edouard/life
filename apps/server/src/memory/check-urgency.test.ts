import { expect, setSystemTime, test } from "bun:test";
import {
  blockingCountOf,
  inboxOrderOf,
  inboxRankOf,
  isInboxCheck,
  urgencyOf,
} from "./check-urgency";
import { checksOnMatterOf } from "./checks";

const check = (group: string, subject: string | null = null) =>
  ({ deadline: null, group, subject }) as never;

test("by kind: decision, unnamed voice, name and card together (these block), then his move (it blocks only when due soon), one person held twice, a guess in use, a new matter, an ending", () => {
  const list = [
    check("decision"),
    check("voice"),
    check("name"),
    check("contacts card"),
    check("your move"),
    check("same person"),
    check("guessed person"),
    check("voice", "person:gran"),
    check("new matter"),
    check("ending"),
  ];
  expect(list.map(inboxRankOf)).toEqual([0, 1, 1, 1, 2, 3, 4, 4, 5, 6]);
  expect(list.map(urgencyOf)).toEqual([
    "blocks",
    "blocks",
    "blocks",
    "blocks",
    "improves",
    "improves",
    "improves",
    "improves",
    "improves",
    "improves",
  ]);
  expect(blockingCountOf(list)).toBe(4);
});

// The cognitive-load rule of 22 Nov 2026: the badge counts a your move card only when it is due within 3 days. The cut
// changes the count, never which cards exist or where they stand.
test("can't be forgotten: a your move card blocks when due within 3 days; later or undated it stays, in its place, without the badge", () => {
  setSystemTime(new Date("2026-11-20T05:00:00.000Z"));
  try {
    const list = [
      ask("guess", "guessed person"),
      ask("move-undated", "your move"),
      ask("move-later", "your move", { deadline: "2026-11-30T16:59:59.999Z" }),
      ask("move-soon", "your move", { deadline: "2026-11-23T16:59:59.999Z" }),
    ];
    expect(list.map((c) => urgencyOf(c))).toEqual([
      "improves",
      "improves",
      "improves",
      "blocks",
    ]);
    expect(blockingCountOf(list)).toBe(1);
    expect(inboxOrderOf(list).map((c: { ref: string }) => c.ref)).toEqual([
      "move-soon",
      "move-later",
      "move-undated",
      "guess",
    ]);
  } finally {
    setSystemTime();
  }
});

const ask = (
  ref: string,
  group: string,
  more: {
    day?: string;
    deadline?: string;
    important?: boolean;
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
    matter: more.matter ? { id: more.matter, important: more.important } : null,
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
    ask("voice-old", "voice", { day: "2026-11-02", observations: 5 }),
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

// His important mark (20 Nov 2026): a marked matter's asks come first in their tier, before deadlines; what blocks stays first.
test("a marked matter's asks lead their tier, before a sooner deadline; what blocks still comes before what improves", () => {
  const order = inboxOrderOf([
    ask("due-soon", "decision", { deadline: "2026-11-07" }),
    ask("offer-marked", "new matter", { important: true, matter: "m2" }),
    ask("marked", "decision", { important: true, matter: "m1" }),
    ask("unmarked", "decision", { matter: "m3" }),
  ]).map((c: { ref: string }) => c.ref);
  expect(order).toEqual(["marked", "due-soon", "unmarked", "offer-marked"]);
});

// Review of #782: matter grouping pulled a card the caretaker is fixing back ahead of an actionable one.
test("a card the caretaker is fixing comes after every actionable card of its tier, its matter's included", () => {
  const order = inboxOrderOf([
    Object.assign(ask("fixing-on-m1", "name", { matter: "m1" }), {
      beingFixed: {},
    }),
    ask("guess-on-m2", "guessed person", { matter: "m2" }),
    ask("guess-on-m1", "guessed person", { matter: "m1", observations: 3 }),
  ]).map((c: { ref: string }) => c.ref);
  expect(order).toEqual(["guess-on-m1", "guess-on-m2", "fixing-on-m1"]);
});

// The cognitive-load rule of 22 Nov 2026: "is this done?" leaves his inbox, never Life. The link stays Life's evidence (the
// step reads probably done until his word), and the check stays on its matter's page.
test("can't be forgotten: an ending check is not in his inbox, and still on its matter's page", () => {
  const list = [
    ask("ending", "ending", { matter: "m1" }),
    ask("move", "your move", { matter: "m1" }),
  ];
  expect(list.filter(isInboxCheck).map((c: { ref: string }) => c.ref)).toEqual([
    "move",
  ]);
  expect(
    checksOnMatterOf<{ matter: never; ref: string; ridesOn: never }>(
      list,
      "m1"
    ).map((c) => c.ref)
  ).toEqual(["ending", "move"]);
});
