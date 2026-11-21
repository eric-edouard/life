import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  type DirectionPin,
  MatterDirectionBatch,
  MatterDirectionFields,
} from "../records/matter";
import { matterDirections } from "./matter-directions";
import {
  directionDueOf,
  directionsOf,
  type MatterView,
  matterFinderOf,
  nextStepNow,
} from "./matter-read";
import { readMatterPins } from "./matters";
import { MATTER_DIRECTIONS } from "./memory-files";

const TODAY = "2026-11-18";

const step = (ref: string, at: string, over = {}) => ({
  at,
  day: at.slice(0, 10),
  kind: "to_do" as const,
  quote: "fix it",
  ref,
  text: `Step ${ref}`,
  ...over,
});

const view = (id: string, over: Partial<MatterView> = {}) =>
  ({
    areas: [],
    id,
    lone: false,
    name: `Matter ${id}`,
    open: true,
    openSteps: [],
    owedTo: [],
    projects: [],
    status: "moving",
    steps: [
      step(`obs_${id.slice(-4).padStart(12, "0")}`, "2026-11-16T09:00:00.000Z"),
      step(
        `unit_${id.slice(-4).padStart(12, "0")}`,
        "2026-11-16T10:00:00.000Z",
        {
          kind: "episode",
        }
      ),
    ],
    waitingOn: [],
    with: [],
    ...over,
  }) as MatterView;

const people = {
  nameOf: (r: string) => r,
  truth: { areas: [], me: { text: "" } },
} as never;

/** What a reader of the records needs for the directions: the pins as stored, the observations, no merged people. */
const recordsOf = (directions: DirectionPin[], observations: unknown[] = []) =>
  ({ directions, observations, refOf: (r: string) => r }) as never;

/** The ids of the matters of `book` due a direction on `today`. */
const dueIds = (
  book: MatterView[],
  directions: DirectionPin[],
  observations: unknown[] = [],
  today = TODAY
) => {
  const isDue = directionDueOf(
    book,
    recordsOf(directions, observations),
    today
  );
  return book.filter((v) => isDue(v.id)).map((v) => v.id);
};

afterEach(() => rmSync(MATTER_DIRECTIONS, { force: true }));

test("the night drafts each running matter's direction, pinned to its steps; a re-group keeps it; drafted again only on a new step or ending", async () => {
  const matters = await import("./matters");
  const models = await import("../models/llm");
  const errand = view("matter_00000000b001");
  const repair = view("matter_00000000b002");
  const book = spyOn(matters, "readMatterBookAndRecords").mockResolvedValue({
    book: [
      errand,
      repair,
      view("matter_00000000b003", { lone: true }),
      view("matter_00000000b004", { status: "dormant" }),
      view("matter_00000000b005", { open: false }),
    ],
    records: recordsOf([]),
  } as never);
  const ask = spyOn(models, "askOnce").mockResolvedValue({
    directions: [
      {
        goal: "The refund is paid back",
        matter: "m1",
        nextStep: { kind: "do", text: "Ask the shop for the refund" },
      },
      {
        goal: "Gran has her watch back",
        matter: "m2",
        nextStep: {
          kind: "wait_event",
          text: "The shop's quote",
          waitsOn: "the shop",
        },
      },
      {
        goal: "Never asked",
        matter: "m9",
        nextStep: { kind: "do", text: "x" },
      },
      // A wait that says not what it waits on is dropped.
      {
        goal: "Bad",
        matter: "m1",
        nextStep: { kind: "wait_owner", text: "y" },
      },
    ],
  } as never);
  try {
    expect(await matterDirections(people, { today: TODAY })).toMatchObject({
      drafted: 2,
      due: 2,
    });
    const pins = readMatterPins().directions;
    expect(pins.map((p) => [p.goal, p.nextStep?.kind, p.steps])).toEqual([
      ["The refund is paid back", "do", errand.steps.map((s) => s.ref)],
      ["Gran has her watch back", "wait_event", repair.steps.map((s) => s.ref)],
    ]);
    expect(pins.map((p) => p.matter)).toEqual([errand.id, repair.id]);
    // A re-group: new ids, the same steps in another order: each direction follows its steps.
    const regrouped = [
      {
        ...errand,
        id: "matter_00000000c001",
        steps: errand.steps.toReversed(),
      },
      { ...repair, id: "matter_00000000c002" },
    ];
    const read = directionsOf(matterFinderOf(regrouped), pins);
    expect(read.get(regrouped[0] as MatterView)?.goal?.text).toBe(
      "The refund is paid back"
    );
    const now = regrouped.map((v) => ({ ...v, ...read.get(v) }));
    expect(dueIds(now, pins)).toEqual([]);
    // A new step, or an ending after the draft, makes it due again; nothing else does.
    const moved = [
      {
        ...now[0],
        steps: [
          ...(now[0]?.steps ?? []),
          step("obs_000000000new", "2026-11-18T08:00:00.000Z"),
        ],
      },
      {
        ...now[1],
        steps: (now[1]?.steps ?? []).map((s, i) =>
          i === 0
            ? { ...s, ending: { at: "2099-01-01T00:00:00.000Z", by: "todo" } }
            : s
        ),
      },
    ] as MatterView[];
    expect(dueIds(moved, pins)).toEqual([
      "matter_00000000c001",
      "matter_00000000c002",
    ]);
    expect(ask).toHaveBeenCalledTimes(1);
  } finally {
    book.mockRestore();
    ask.mockRestore();
  }
});

test("his goal wins over every draft; his next step wins until Life drafts again; a split keeps them with the part holding a pinned step", () => {
  const [s1, s2, s3] = [
    "obs_000000000001",
    "unit_000000000002",
    "obs_000000000003",
  ];
  const next = (text: string) => ({ kind: "do" as const, text });
  const pins: DirectionPin[] = [
    {
      at: "2026-11-10T02:00:00.000Z",
      by: "life",
      goal: "Draft one",
      nextStep: next("Life one"),
      steps: [s1, s2, s3],
    },
    {
      at: "2026-11-11T09:00:00.000Z",
      by: "owner",
      goal: "His goal",
      steps: [s2],
    },
    {
      at: "2026-11-11T10:00:00.000Z",
      by: "owner",
      nextStep: next("His step"),
      steps: [s1, s2, s3],
    },
  ];
  const whole = {
    id: "matter_000000000001",
    steps: [s1, s2, s3].map((ref) => ({ ref })),
  };
  expect(directionsOf(matterFinderOf([whole]), pins).get(whole)).toMatchObject({
    goal: { by: "owner", text: "His goal" },
    nextStep: { by: "owner", text: "His step" },
  });
  const later = [
    ...pins,
    {
      at: "2026-11-12T02:00:00.000Z",
      by: "life" as const,
      goal: "Draft two",
      nextStep: next("Life two"),
      steps: [s1, s2, s3],
    },
  ];
  expect(directionsOf(matterFinderOf([whole]), later).get(whole)).toMatchObject(
    {
      goal: { by: "owner", text: "His goal" },
      nextStep: { by: "life", text: "Life two" },
    }
  );
  const [left, right] = [
    { id: "matter_000000000002", steps: [{ ref: s2 }] },
    { id: "matter_000000000003", steps: [{ ref: s1 }, { ref: s3 }] },
  ];
  const split = directionsOf(matterFinderOf([left, right]), pins.slice(0, 1));
  expect(split.get(right)?.goal?.text).toBe("Draft one");
  expect(split.has(left)).toBe(false);
});

test("a matter waits on his decision while one he has not answered is about one of its steps", () => {
  const v = view("matter_00000000d001", {
    nextStep: {
      at: "2026-11-17T02:00:00.000Z",
      by: "life",
      kind: "do",
      text: "Order the beads",
    },
  });
  expect(nextStepNow(v, [])).toMatchObject({ kind: "do" });
  expect(
    nextStepNow(v, [
      { question: "Which colour?", subject: "project:shop" },
      { question: "Order 200 or 500?", subject: v.steps[0]?.ref },
    ])
  ).toEqual({
    kind: "wait_decision",
    text: "Order 200 or 500?",
    waitsOn: "his decision",
  });
});

test("a direction goes to the matter holding most of its pinned steps, though its first step is a unit another matter also holds", () => {
  const shared = "unit_000000000001";
  const own = ["obs_000000000002", "obs_000000000003"];
  const pin: DirectionPin = {
    at: "2026-11-18T02:00:00.000Z",
    by: "life",
    goal: "The parcel is home",
    nextStep: { kind: "do", text: "Ask the courier" },
    steps: [shared, ...own],
  };
  const other = { id: "matter_000000000010", steps: [{ ref: shared }] };
  const mine = {
    id: "matter_000000000011",
    steps: [shared, ...own].map((ref) => ({ ref })),
  };
  for (const book of [
    [other, mine],
    [mine, other],
  ]) {
    const read = directionsOf(matterFinderOf(book), [pin]);
    expect(read.get(mine)?.goal?.text).toBe("The parcel is home");
    expect(read.has(other)).toBe(false);
  }
  // The smaller matter's own pin stays with it, whatever the order: a tie goes to the one with the fewest steps.
  const small = { ...pin, goal: "The courier calls back", steps: [shared] };
  for (const book of [
    [other, mine],
    [mine, other],
  ]) {
    expect(
      directionsOf(matterFinderOf(book), [small]).get(other)?.goal?.text
    ).toBe("The courier calls back");
  }
});

const wait = (id: string, day = "2026-11-16") =>
  step(id, `${day}T09:00:00.000Z`, {
    kind: "waiting_on_someone" as const,
    quote: "waiting for Sam",
    text: "Waiting for Sam's answer",
  });

/** A running matter waiting on Sam, with a direction by Life that Life has drafted. */
const waiting = (id: string) => {
  const open = wait(`obs_${id}`);
  return view(`matter_${id}`, {
    goal: { at: "2026-11-17T02:00:00.000Z", by: "life", text: "Sam answers" },
    openSteps: [open],
    steps: [open],
    waitingOn: ["person:sam"],
  });
};
const pinOf = (
  v: MatterView,
  over: Partial<DirectionPin> = {}
): DirectionPin => ({
  at: "2026-11-17T02:00:00.000Z",
  by: "life",
  goal: "Sam answers",
  nextStep: { kind: "wait_event", text: "Sam's answer", waitsOn: "Sam" },
  steps: v.steps.map((s) => s.ref),
  ...over,
});
/** A record by Sam outside the matter, `n` days into November. */
const said = (n: number) => ({
  at: `2026-11-${String(n).padStart(2, "0")}T12:00:00.000Z`,
  date: `2026-11-${String(n).padStart(2, "0")}`,
  id: `obs_said${String(n).padStart(8, "0")}`,
  speaker: "person:sam",
  subjects: [],
  text: `Sam said something on the ${n}th`,
  type: "event",
});

test("a blind Life pin is due once; his own pin never is, and an outside record only makes a direction due in the offer window", () => {
  const v = waiting("00000000e001");
  // Drafted before it saw later records: no `laterShown`.
  expect(dueIds([v], [pinOf(v)])).toEqual([v.id]);
  expect(dueIds([v], [pinOf(v, { laterShown: [] })])).toEqual([]);
  // His own word, with nothing new to the matter, is never drafted over for what happened elsewhere.
  expect(dueIds([v], [pinOf(v, { by: "owner" })], [said(17)])).toEqual([]);
  expect(dueIds([v], [pinOf(v, { laterShown: [] })], [said(17)])).toEqual([
    v.id,
  ]);
  // The offer window ends 7 days from the first step's day (16 Nov): the card is gone, so is the reason.
  expect(
    dueIds([v], [pinOf(v, { laterShown: [] })], [said(17)], "2026-11-23")
  ).toEqual([]);
  // A record the draft was shown is checked.
  expect(
    dueIds([v], [pinOf(v, { laterShown: [said(17).id] })], [said(17)])
  ).toEqual([]);
});

test("only the newest 12 later records are compared: an older one outside them never keeps a direction due", () => {
  const v = waiting("00000000e002");
  const records = Array.from({ length: 13 }, (_, i) => said(i + 17));
  const newest = records.slice(1).map((o) => o.id);
  expect(dueIds([v], [pinOf(v, { laterShown: newest })], records)).toEqual([]);
  // A newer one pushes the oldest shown out and is itself unseen.
  expect(
    dueIds([v], [pinOf(v, { laterShown: newest })], [...records, said(30)])
  ).toEqual([v.id]);
});

// 19 Nov 2026 audit: "waiting for the landlord" stayed a card after the deposit came back in another matter.
test("a matter that looks over gets no next step: its draft cites only records it was shown, an unknown id is dropped (stale-2-wait-answered-in-other-matter)", async () => {
  const matters = await import("./matters");
  const models = await import("../models/llm");
  const v = waiting("00000000e003");
  const book = spyOn(matters, "readMatterBookAndRecords").mockResolvedValue({
    book: [v],
    records: recordsOf([], [said(17)]),
  } as never);
  const ask = spyOn(models, "askOnce").mockResolvedValue({
    directions: [
      {
        endingRecords: [said(17).id, "obs_neverShown"],
        goal: "Sam has answered",
        matter: "m1",
      },
    ],
  } as never);
  try {
    await matterDirections(people, { today: TODAY });
    // The call was shown the record, said by name.
    expect(JSON.stringify(ask.mock.calls[0])).toContain(said(17).id);
    const [pin] = readMatterPins().directions;
    expect(pin).toMatchObject({
      endingRecords: [said(17).id],
      goal: "Sam has answered",
      laterShown: [said(17).id],
    });
    expect(pin?.nextStep).toBeUndefined();
    // Read back: a Life draft with no next step clears the old one, and its records are the matter's to cite.
    const read = directionsOf(matterFinderOf([v]), [
      pinOf(v),
      ...(pin ? [pin] : []),
    ]).get(v);
    expect(read?.nextStep).toBeUndefined();
    expect(read?.latest?.endingRecords).toEqual([said(17).id]);
    // A draft with both, or neither, is refused whole.
    ask.mockResolvedValue({
      directions: [
        { goal: "x", matter: "m1" },
        {
          endingRecords: [],
          goal: "y",
          matter: "m1",
          nextStep: { kind: "do", text: "z" },
        },
      ],
    } as never);
    rmSync(MATTER_DIRECTIONS, { force: true });
    expect(await matterDirections(people, { today: TODAY })).toMatchObject({
      drafted: 0,
    });
  } finally {
    book.mockRestore();
    ask.mockRestore();
  }
});

test("a stored line of v1 (a next step, no laterShown) still parses; a draft with both a next step and endingRecords is refused", () => {
  const draft = {
    goal: "Sam answers",
    nextStep: { kind: "do", text: "Ask Sam" },
    steps: ["obs_000000000001"],
  };
  const line = (d: object) => ({
    at: "2026-11-17T02:00:00.000Z",
    directions: [d],
    madeBy: {
      engine: "claude",
      model: "m",
      prompt: "memory-matter-directions.v1",
      run: "r",
    },
    schemaVersion: 1,
  });
  expect(MatterDirectionBatch.safeParse(line(draft)).success).toBe(true);
  expect(
    MatterDirectionBatch.safeParse(line({ ...draft, endingRecords: [] }))
      .success
  ).toBe(false);
});

// life#817: a next step's context is his word's alone; Life's drafts carry none.
test("a drafted next step carrying a context is refused", () => {
  const draft = (nextStep: object) =>
    MatterDirectionFields.safeParse({ goal: "Gran has her watch", nextStep })
      .success;
  expect(draft({ kind: "do", text: "Call the shop" })).toBe(true);
  expect(
    draft({ context: "Because.", kind: "do", text: "Call the shop" })
  ).toBe(false);
});
