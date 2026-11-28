import { expect, setSystemTime, spyOn, test } from "bun:test";
import { yourMoveClosingOf } from "./answer-check";
import type { CheckInputs } from "./check-context";
import {
  blockingCountOf,
  inboxOf,
  inboxOrderOf,
  isInboxCheck,
  urgencyOf,
} from "./check-urgency";
import { checksOf, checksOnMatterOf, type InboxCheck } from "./checks";
import { holdOn, inputs } from "./checks-test-inputs";
import type { Check } from "./life-checks";
import { Need, needsShownOf } from "./needs";
import { placesOf } from "./your-move";
import { localDate } from "./zones";

// Your move cards: a matter's step that is his stays in his inbox, dormant or not, until he does it, hands it to an
// agent, or says Not now. Made-up matters only.

const OWN = {
  at: "2026-10-20T09:00:00.000Z",
  day: "2026-10-20",
  kind: "to_do" as const,
  quote: "I need to buy paint for the fence",
  ref: "obs_000000000081",
  text: "Buy paint for the garden fence",
};
const WAIT = {
  at: "2026-10-21T09:00:00.000Z",
  day: "2026-10-21",
  kind: "waiting_on_someone" as const,
  quote: "waiting for the neighbour to pick a colour",
  ref: "obs_000000000082",
  text: "The neighbour picks a colour",
};
const MATTER = {
  goal: {
    at: "2026-10-21T02:00:00Z",
    by: "life" as const,
    text: "The garden fence is painted",
  },
  id: "matter_000000000081",
  lone: false,
  name: "Garden fence",
  newestOpenStep: WAIT,
  nextStep: {
    at: "2026-10-21T02:00:00Z",
    by: "life" as const,
    kind: "do" as const,
    text: "Buy the paint.",
  },
  open: true,
  openSteps: [OWN, WAIT],
  owedTo: [],
  projects: [] as string[],
  // Quiet for a month: dormant, and no list of running matters shows it.
  status: "dormant" as const,
  steps: [OWN, WAIT],
  waitingOn: [],
  with: [],
};
const base = inputs([], { matters: [MATTER] });
const moves = (over: Partial<CheckInputs> = {}) =>
  checksOf({ ...base, ...over }).filter((c) => c.group === "your move");
const idsOf = (c?: Check) => c?.options.map((o) => o.id);

test("a dormant matter whose open step is his shows one your move card: his step, Done, Hand over, Not now, Drop", () => {
  const [card, ...more] = moves();
  expect(more).toEqual([]);
  expect(card).toMatchObject({
    asker: "life",
    deadline: null,
    goal: "The garden fence is painted",
    kind: "your move",
    matter: { id: MATTER.id, name: "Garden fence" },
    needs: [],
    onSilence: null,
    question: "Buy paint for the garden fence",
    ref: `move:${MATTER.id}/${OWN.ref}`,
    subject: OWN.ref,
    title: "Garden fence",
  });
  expect(card?.context).toContain("Next step: Buy the paint.");
  expect(card?.options).toEqual([
    {
      ends: "step",
      icon: "done",
      id: "done",
      label: "Mark as done",
      takes: null,
    },
    { icon: "agent", id: "start", label: "Hand over", takes: null },
    { icon: "later", id: "not-now", label: "Not now", takes: null },
    { ends: "step", icon: "drop", id: "drop", label: "Drop", takes: null },
  ]);
  // One card per matter: while it is offered as a new matter, that card asks first; once the offer ends, his move.
  const running = { matters: [{ ...MATTER, status: "moving" as const }] };
  expect(
    checksOf({ ...base, ...running, today: "2026-10-22" }).map((c) => c.group)
  ).toEqual(["new matter"]);
  expect(
    checksOf({ ...base, ...running, today: "2026-10-30" }).map((c) => c.group)
  ).toEqual(["your move"]);
});

test("a pure wait on someone, a closed matter, a parked project or an open decision show no your move card", () => {
  for (const list of [
    moves({ matters: [{ ...MATTER, openSteps: [WAIT] }] }),
    moves({ matters: [{ ...MATTER, open: false, status: "done" as const }] }),
    moves({ isParked: () => true }),
    moves({
      decisions: [
        {
          at: "2026-10-22T09:00:00.000Z",
          drafts: [],
          id: "dec_000000000081",
          links: [],
          options: [],
          subject: OWN.ref,
        } as unknown as CheckInputs["decisions"][number],
      ],
    }),
  ]) {
    expect(list).toEqual([]);
  }
});

test("an active agent working on it holds it; an agent waiting on him shows his move; a stopped agent, a closed try or the desk off still shows it; Start only where an agent could take it", () => {
  const held = { heldByAgents: [holdOn(WAIT.ref)] };
  expect(moves(held)).toEqual([]);
  const waits = moves({
    ...held,
    matters: [
      { ...MATTER, nextStep: { ...MATTER.nextStep, kind: "wait_owner" } },
    ],
  });
  expect(waits.map(idsOf)).toEqual([["done", "not-now", "drop"]]);
  // A stopped agent's open assignment can't work on it: his move shows, with no Start (it is still held).
  expect(
    moves({ heldByAgents: [holdOn(WAIT.ref, { status: "stopped" })] }).map(
      idsOf
    )
  ).toEqual([["done", "not-now", "drop"]]);
  const closed = [holdOn(WAIT.ref, { closedAt: "2026-10-22T00:00:00Z" })];
  expect(moves({ heldByAgents: closed }).map(idsOf)).toEqual([
    ["done", "start", "not-now", "drop"],
  ]);
  const handOut = { isForHandOut: (id: string) => id === MATTER.id };
  for (const over of [
    { heldByAgents: null },
    // He dismissed its offer, or the hand-out takes it (a running matter of his): Done and Not now stay.
    { dismissed: [[OWN.ref]] },
    { ...handOut, matters: [{ ...MATTER, status: "moving" as const }] },
  ]) {
    expect(moves(over).map(idsOf)).toEqual([["done", "not-now", "drop"]]);
  }
  // The hand-out never takes a dormant matter: it keeps its Start.
  expect(moves(handOut).map(idsOf)).toEqual([
    ["done", "start", "not-now", "drop"],
  ]);
});

test("its step due first is shown, due to the last instant of its own day, a missed day first; an appointment's place is a place need with its map links", () => {
  const due = {
    ...OWN,
    ref: "obs_000000000084",
    text: "Pay the paint shop",
    when: "2026-11-18",
  };
  const old = { ...OWN, ref: "obs_000000000085", when: "2026-09-01" };
  const [card] = moves({
    matters: [{ ...MATTER, openSteps: [OWN, due, WAIT] }],
    places: placesOf([{ observations: [due.ref], place: "Paint shop" }]),
  });
  expect(card?.question).toBe("Pay the paint shop");
  expect(localDate(card?.deadline ?? "")).toBe("2026-11-18");
  expect(card?.needs).toEqual([
    {
      appleMapsUrl: "https://maps.apple.com/?q=Paint%20shop",
      googleMapsUrl:
        "https://www.google.com/maps/search/?api=1&query=Paint%20shop",
      kind: "place",
      line: "Paint shop",
      name: "Paint shop",
    },
  ]);
  // A day long missed still asks, first, with its day as the deadline.
  const [late] = moves({ matters: [{ ...MATTER, openSteps: [OWN, old] }] });
  expect(late).toMatchObject({ subject: old.ref });
  expect(localDate(late?.deadline ?? "")).toBe("2026-09-01");
  // An observation at two places has none; a place `redact` would hide part of is not shown at all.
  expect(
    placesOf([
      { observations: [OWN.ref], place: "Print shop" },
      { observations: [OWN.ref], place: "Copy corner" },
    ]).size
  ).toBe(0);
  const [hidden] = moves({
    places: new Map([[OWN.ref, "Gate code 4111 1111 1111 1111"]]),
  });
  expect(hidden?.needs).toEqual([]);
});

// A step of his stays asked until it ended or his word (his rules of 27 and 28 Nov 2026): its age, a missed day or its
// sender never hides it, only his words or its being handled elsewhere (`askOfStep`); the walk over every path is
// `open-steps-asked.test.ts`. Made-up matters.
test("a to-do item open in his list is his move, like his own task", () => {
  const item = {
    ...OWN,
    kind: "todo_item" as const,
    ref: "entry_000000000001",
    text: "Renew the bike papers",
  };
  expect(
    moves({ matters: [{ ...MATTER, openSteps: [item], steps: [item] }] })
  ).toMatchObject([{ question: item.text, subject: item.ref }]);
});

// Card sort (his words of 28 Nov 2026), regression cases with made-up matters: his own code work is on its matter's
// page only, with no Start; a promise beside it is what the card asks; with no reading a due day alone blocks.
const REFACTOR = {
  ...OWN,
  at: "2026-10-22T09:00:00.000Z",
  ref: "obs_000000000086",
  text: "Refactor the invoice exporter",
};
const PROMISE = {
  ...OWN,
  kind: "promise" as const,
  ref: "obs_000000000087",
  text: "Send Dana the fence measurements",
  with: "person:dana",
};
const elsewhere = {
  stepReadingsOf: (_: string, step: { ref: string }) =>
    step.ref === REFACTOR.ref
      ? {
          by: null,
          handledBy: "owner_elsewhere" as const,
          money: "none" as const,
          urgency: "normal" as const,
        }
      : undefined,
};

test("card sort: his own refactor is on its matter's page only, with no Start; a promise on the same matter is what its card asks", () => {
  const solo = { matters: [{ ...MATTER, openSteps: [REFACTOR, WAIT] }] };
  const [card] = moves({ ...solo, ...elsewhere });
  expect(card).toMatchObject({ isHidden: true, subject: REFACTOR.ref });
  expect(isInboxCheck(card as Check)).toBe(false);
  expect(checksOnMatterOf([card as Check], MATTER.id)).toHaveLength(1);
  expect(idsOf(card)).toEqual(["done", "not-now", "drop"]);
  const [both] = moves({
    ...elsewhere,
    matters: [{ ...MATTER, openSteps: [REFACTOR, PROMISE, WAIT] }],
  });
  expect(both).toMatchObject({ isHidden: false, subject: PROMISE.ref });
  // No reading yet: as before, asked.
  expect(moves(solo)[0]).toMatchObject({ isHidden: false });
});

test("card sort: with no reading, a step due within 3 days blocks; one due later does not", () => {
  const due = (when: string) =>
    moves({
      matters: [{ ...MATTER, openSteps: [{ ...OWN, when }] }],
      today: "2026-11-28",
    }).map((c) => urgencyOf(c));
  expect(due("2026-12-01")).toEqual(["blocks"]);
  expect(due("2026-12-02")).toEqual(["improves"]);
});

test("a card due today counts in deadlinesToday on its day", () => {
  setSystemTime(new Date("2026-11-18T05:00:00.000Z"));
  try {
    const [card] = moves({
      matters: [{ ...MATTER, openSteps: [{ ...OWN, when: "2026-11-18" }] }],
    });
    expect(inboxOf([card as Check]).deadlinesToday).toBe(1);
  } finally {
    setSystemTime();
  }
});

test("a place need takes only https links, and its line names it with its address", () => {
  const place = { kind: "place", name: "Paint shop" };
  expect(Need.safeParse({ ...place, boltUrl: "http://x.test" }).success).toBe(
    false
  );
  expect(
    needsShownOf([
      Need.parse({
        ...place,
        address: "1 Main Rd",
        boltUrl: "https://ride.example.com/r",
      }),
    ])[0]?.line
  ).toBe("Paint shop, 1 Main Rd");
});

test("an app need takes an https link only, and its line names the app", () => {
  expect(
    Need.safeParse({ kind: "app", name: "Grab", url: "grab://x" }).success
  ).toBe(false);
  expect(
    needsShownOf([
      Need.parse({ kind: "app", name: "Grab", url: "https://g.example.com/a" }),
    ])[0]?.line
  ).toBe("In Grab");
});

test("your move takes its place among every ask by deadline, then importance, then the longest waiting (no ranks by kind); the badge counts it when it blocks", () => {
  setSystemTime(new Date("2026-11-28T05:00:00.000Z"));
  const card = (
    ref: string,
    group: Check["group"],
    over: {
      day?: string;
      deadline?: string | null;
      important?: true;
      matter?: string;
    } = {}
  ) => ({
    day: over.day ?? "2026-11-01",
    deadline: over.deadline ?? null,
    group,
    matter: { id: over.matter ?? `matter_${ref}`, important: over.important },
    ref,
    ridesOn: { matterIds: [], matters: 0, observations: 0, pages: 0 },
    subject: null,
  });
  const list = [
    card("move-old", "your move", { day: "2026-10-01" }),
    card("move-new", "your move", { day: "2026-11-10", important: true }),
    card("move-due-later", "your move", {
      deadline: "2026-12-30T16:59:59.999Z",
      important: true,
    }),
    {
      ...card("move-due", "your move", {
        deadline: "2026-11-30T16:59:59.999Z",
        matter: "matter_shared",
      }),
      isBlocking: true,
    },
    card("guess", "guessed person"),
    card("decision", "decision"),
    // A name on the same important matter as a dated move: the move never rides ahead of the decision with it.
    card("name", "name", { important: true, matter: "matter_shared" }),
  ];
  // The dated move first (its matter's name with it), then the next deadline, then the important one, then the longest waiting.
  expect(inboxOrderOf(list).map((c) => c.ref)).toEqual([
    "move-due",
    "name",
    "move-due-later",
    "move-new",
    "move-old",
    "decision",
    "guess",
  ]);
  expect(list.map((c) => urgencyOf(c))).toEqual([
    "improves",
    "improves",
    "improves",
    "blocks",
    "improves",
    "blocks",
    "blocks",
  ]);
  expect(blockingCountOf(list)).toBe(3);
  setSystemTime();
});

test("Mark as done closes only the card's step, never its siblings", async () => {
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue(
    {} as never
  );
  const book = spyOn(
    await import("./matters"),
    "readMatterBook"
  ).mockResolvedValue([MATTER] as never);
  try {
    const card = {
      matter: { id: MATTER.id },
      ref: `move:${MATTER.id}/${OWN.ref}`,
      subject: OWN.ref,
    } as InboxCheck;
    expect((await yourMoveClosingOf(card)).map((s) => s.ref)).toEqual([
      OWN.ref,
    ]);
    await expect(
      yourMoveClosingOf({ ...card, subject: "obs_000000000099" })
    ).rejects.toThrow("no longer open");
  } finally {
    book.mockRestore();
    people.mockRestore();
  }
});

// Regression cases stack-2-admin-cover-ranked and stack-3-low-paperwork-ranked (his data, docs/evals/cases): his moves
// in his ranking's order, never by age alone. Made-up matters.
test("your move cards follow his ranking (`matterRank`), not the oldest step: a high-ranked admin step above an older low one", () => {
  const step = (n: number, day: string, text: string) => ({
    ...OWN,
    at: `${day}T09:00:00.000Z`,
    day,
    ref: `obs_00000000009${n}`,
    text,
  });
  const matter = (n: number, s: ReturnType<typeof step>) => ({
    ...MATTER,
    id: `matter_00000000009${n}`,
    newestOpenStep: s,
    openSteps: [s],
    steps: [s],
  });
  // Older, but low in his ranking: the scooter's papers; newer, high: the health cover he marked high.
  const papers = matter(1, step(1, "2026-10-25", "Register the scooter"));
  const cover = matter(2, step(2, "2026-11-01", "Find health insurance"));
  const order = (matterRank?: Map<string, number>) =>
    moves({ matterRank, matters: [papers, cover] }).map((c) => c.matter?.id);
  expect(order()).toEqual([papers.id, cover.id]);
  expect(
    order(
      new Map([
        [cover.id, 0],
        [papers.id, 40],
      ])
    )
  ).toEqual([cover.id, papers.id]);
});

test("among your move cards, his ranking beats a deadline: a low-ranked dated step goes below a high-ranked undated one", () => {
  const move = (ref: string, matterRank: number, deadline: string | null) => ({
    day: "2026-11-01",
    deadline,
    group: "your move" as const,
    matter: { id: `matter_${ref}` },
    matterRank,
    ref,
    ridesOn: { matterIds: [], matters: 0, observations: 0, pages: 0 },
    subject: null,
  });
  expect(
    inboxOrderOf([
      move("dated-low", 9, "2026-11-02T16:59:59.999Z"),
      move("undated-high", 1, null),
    ]).map((c) => c.ref)
  ).toEqual(["undated-high", "dated-low"]);
});
