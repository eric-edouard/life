import { expect, setSystemTime, spyOn, test } from "bun:test";
import { yourMoveClosingOf } from "./answer-check";
import type { CheckInputs } from "./check-context";
import {
  blockingCountOf,
  inboxOf,
  inboxOrderOf,
  urgencyOf,
} from "./check-urgency";
import { checksOf, type InboxCheck } from "./checks";
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

test("a dormant matter whose open step is his shows one your move card: his step, Done, Hand to an agent, Not now, Drop", () => {
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
    { ends: "step", id: "done", label: "Mark as done", takes: null },
    { id: "start", label: "Hand to an agent", takes: null },
    { id: "not-now", label: "Not now", takes: null },
    { ends: "step", id: "drop", label: "Drop", takes: null },
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

test("an agent working on it holds it; an agent waiting on him shows his move; a closed try or the desk off still shows it; Start only where an agent could take it", () => {
  const held = { heldByAgents: [holdOn(WAIT.ref)] };
  expect(moves(held)).toEqual([]);
  const waits = moves({
    ...held,
    matters: [
      { ...MATTER, nextStep: { ...MATTER.nextStep, kind: "wait_owner" } },
    ],
  });
  expect(waits.map(idsOf)).toEqual([["done", "not-now", "drop"]]);
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

test("Not now hides it until its day, and a new step on the matter brings it back early", () => {
  const notNow = [
    {
      at: "2026-11-18T09:00:00.000Z",
      matter: MATTER.id,
      steps: [OWN.ref, WAIT.ref],
      until: "2026-11-21",
    },
  ];
  expect(moves({ notNow, today: "2026-11-20" })).toEqual([]);
  expect(moves({ notNow, today: "2026-11-21" })).toHaveLength(1);
  const newer = { ...WAIT, ref: "obs_000000000083" };
  expect(
    moves({
      matters: [{ ...MATTER, steps: [...MATTER.steps, newer] }],
      notNow,
      today: "2026-11-20",
    })
  ).toHaveLength(1);
});

test("its step due first is shown, due to the last instant of its own day; a date long past is no deadline; an appointment's place is a place need with its map links", () => {
  const due = {
    ...OWN,
    ref: "obs_000000000084",
    text: "Pay the paint shop",
    when: "2026-11-18",
  };
  const old = { ...OWN, ref: "obs_000000000085", when: "2026-09-01" };
  const [card] = moves({
    matters: [{ ...MATTER, openSteps: [old, OWN, due, WAIT] }],
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
  // Only a date long past: no deadline, the newest step shown.
  const [late] = moves({ matters: [{ ...MATTER, openSteps: [old, OWN] }] });
  expect(late).toMatchObject({ deadline: null, question: OWN.text });
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

test("your move comes after every agent's decision, by deadline then the longest waiting, whatever the matter's mark; the badge always counts it", () => {
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
    card("move-due", "your move", {
      deadline: "2026-11-30T16:59:59.999Z",
      matter: "matter_shared",
    }),
    card("guess", "guessed person"),
    card("decision", "decision"),
    // A name on the same important matter as a dated move: the move never rides ahead of the decision with it.
    card("name", "name", { important: true, matter: "matter_shared" }),
  ];
  expect(inboxOrderOf(list).map((c) => c.ref)).toEqual([
    "name",
    "decision",
    "move-due",
    "move-due-later",
    "move-old",
    "move-new",
    "guess",
  ]);
  expect(list.map((c) => urgencyOf(c))).toEqual([
    "blocks",
    "blocks",
    "blocks",
    "blocks",
    "improves",
    "blocks",
    "blocks",
  ]);
  expect(blockingCountOf(list)).toBe(6);
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
test("your move cards follow his ranking (`rank`), not the oldest step: a high-ranked admin step above an older low one", () => {
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
  const papers = matter(1, step(1, "2026-10-01", "Register the scooter"));
  const cover = matter(2, step(2, "2026-10-18", "Find health insurance"));
  const order = (rank?: Map<string, number>) =>
    moves({ matters: [papers, cover], rank }).map((c) => c.matter?.id);
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
