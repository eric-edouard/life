import { expect, test } from "bun:test";
import {
  askOfStep,
  blockingCountOf,
  inboxOrderOf,
  isInboxCheck,
  type StepAskFacts,
  type StepAskReadings,
  urgencyOf,
} from "./check-urgency";
import { checksOnMatterOf } from "./checks";

const check = (group: string, subject: string | null = null) =>
  ({ deadline: null, group, subject }) as never;

test("what blocks: a decision, a name and a card (these block); a your move card only when due soon; a voice and the rest improve", () => {
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
  expect(list.map(urgencyOf)).toEqual([
    "blocks",
    "improves",
    "blocks",
    "blocks",
    "improves",
    "improves",
    "improves",
    "improves",
    "improves",
    "improves",
  ]);
  expect(blockingCountOf(list)).toBe(3);
});

// The badge counts a your move card only when `askOfStep` says it blocks; the cut changes the count, never which cards
// exist or where they stand.
test("a your move card blocks only when it says so (`isBlocking`); a blocking one in its place, the rest without the badge", () => {
  const list = [
    ask("guess", "guessed person"),
    ask("move-undated", "your move"),
    Object.assign(
      ask("move-later", "your move", { deadline: "2026-11-30T16:59:59.999Z" }),
      { isBlocking: false }
    ),
    Object.assign(
      ask("move-soon", "your move", { deadline: "2026-11-23T16:59:59.999Z" }),
      { isBlocking: true }
    ),
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
    "guess",
    "move-undated",
  ]);
});

// Card sort (his words of 28 Nov 2026): Life asks only what needs him, and when. Regression cases of the one rule,
// made-up steps: the readings are the model's, the dates and the floor code's.
const TODAY = "2026-11-28";
const reading = (over: Partial<StepAskReadings> = {}): StepAskReadings => ({
  by: null,
  handledBy: "owner",
  money: "none",
  urgency: "normal",
  ...over,
});
const todo = (over: Partial<StepAskFacts> = {}): StepAskFacts => ({
  first: "2026-11-20",
  isPromiseToPerson: false,
  ...over,
});
const NO_WORDS = new Set<string>();
const STOCK = "ins_0000000000a1";

test("card sort: his own code work elsewhere and an ask to his assistant are hidden; a code promise to a person stays asked", () => {
  const elsewhere = reading({ handledBy: "owner_elsewhere" });
  expect(askOfStep(elsewhere, todo(), NO_WORDS, TODAY)).toEqual({
    isBlocking: false,
    isHidden: true,
  });
  expect(
    askOfStep(reading({ handledBy: "someone_else" }), todo(), NO_WORDS, TODAY)
      .isHidden
  ).toBe(true);
  // "I'll fix the login bug for Dana": the work is code, the person waits.
  expect(
    askOfStep(elsewhere, todo({ isPromiseToPerson: true }), NO_WORDS, TODAY)
  ).toEqual({ isBlocking: false, isHidden: false });
});

test("card sort: a bill for goods delivered with no due day is asked at day 6, blocks from day 7 on, day 40 too, until done", () => {
  const bill = reading({ money: "due_on_receipt" });
  const at = (first: string) =>
    askOfStep(bill, todo({ first }), NO_WORDS, TODAY);
  expect(at("2026-11-22")).toEqual({ isBlocking: false, isHidden: false });
  expect(at("2026-11-21").isBlocking).toBe(true);
  expect(at("2026-11-20").isBlocking).toBe(true);
  expect(at("2026-10-19").isBlocking).toBe(true);
  // Someone else's move with money and no words of his: never hidden.
  expect(
    askOfStep(
      reading({ handledBy: "someone_else", money: "some" }),
      todo(),
      NO_WORDS,
      TODAY
    ).isHidden
  ).toBe(false);
});

test("card sort: any due day protects; urgent blocks, a good-moment errand does not; no reading blocks only by its due day", () => {
  // An overdue to-do the model reads as someone else's: asked, and blocking.
  expect(
    askOfStep(
      reading({ handledBy: "someone_else" }),
      todo({ due: "2026-11-01" }),
      NO_WORDS,
      TODAY
    )
  ).toEqual({ isBlocking: true, isHidden: false });
  expect(
    askOfStep(reading({ urgency: "high" }), todo(), NO_WORDS, TODAY).isBlocking
  ).toBe(true);
  // Buy oranges at the market: a good moment, nobody waits.
  expect(
    askOfStep(reading({ urgency: "low" }), todo(), NO_WORDS, TODAY)
  ).toEqual({ isBlocking: false, isHidden: false });
  expect(
    askOfStep(undefined, todo({ due: "2026-11-30" }), NO_WORDS, TODAY)
  ).toEqual({ isBlocking: true, isHidden: false });
  expect(
    askOfStep(undefined, todo({ due: "2026-12-02" }), NO_WORDS, TODAY)
  ).toEqual({ isBlocking: false, isHidden: false });
});

test("card sort: his stock-orders words hide a supplier invoice they cite, never rent, tax or a DIY bill; replacing them un-hides at once", () => {
  const words = new Set([STOCK]);
  const invoice = reading({ by: STOCK, money: "some" });
  expect(askOfStep(invoice, todo(), words, TODAY).isHidden).toBe(true);
  // Rent, the property tax, a DIY shop's bill: no `by`, money protects them, even read as someone else's.
  for (const r of [
    reading({ money: "some" }),
    reading({ handledBy: "someone_else", money: "some" }),
    reading({ money: "due_on_receipt" }),
  ]) {
    expect(askOfStep(r, todo(), words, TODAY).isHidden).toBe(false);
  }
  // His words replaced: their id is no longer in force, the invoice is asked again before any night.
  expect(askOfStep(invoice, todo(), NO_WORDS, TODAY).isHidden).toBe(false);
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

test("the order: deadlines soonest, then important, then the longest waiting, whatever the kind; a matter's asks together", () => {
  const order = inboxOrderOf([
    ask("ending", "ending", { day: "2026-11-01" }),
    ask("offer", "new matter", { day: "2026-11-04" }),
    ask("decision-new", "decision", { day: "2026-11-03" }),
    ask("due-late", "decision", { deadline: "2026-11-09" }),
    ask("due-soon", "voice", { deadline: "2026-11-07" }),
    Object.assign(ask("high", "decision", { day: "2026-11-05" }), {
      importance: "high",
    }),
    ask("marked", "guessed person", {
      day: "2026-11-05",
      important: true,
      matter: "m1",
    }),
    // Of m1, asked long ago, but not important: it moves up behind m1's first ask.
    ask("name-on-m1", "name", { day: "2026-11-02", matter: "m1" }),
  ]).map((c: { ref: string }) => c.ref);
  expect(order).toEqual([
    "due-soon",
    "due-late",
    "high",
    "marked",
    "name-on-m1",
    "ending",
    "decision-new",
    "offer",
  ]);
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
test("can't be forgotten: an ending check and a hidden your move card are not in his inbox, and still on their matter's page", () => {
  const list = [
    ask("ending", "ending", { matter: "m1" }),
    ask("move", "your move", { matter: "m1" }),
    Object.assign(ask("hidden", "your move", { matter: "m1" }), {
      isHidden: true,
    }),
  ];
  expect(list.filter(isInboxCheck).map((c: { ref: string }) => c.ref)).toEqual([
    "move",
  ]);
  expect(
    checksOnMatterOf<{ matter: never; ref: string; ridesOn: never }>(
      list,
      "m1"
    ).map((c) => c.ref)
  ).toEqual(["ending", "move", "hidden"]);
});
