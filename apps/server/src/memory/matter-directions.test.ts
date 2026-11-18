import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import type { DirectionPin } from "../records/matter";
import { dueDirectionsOf, matterDirections } from "./matter-directions";
import { directionsOf, type MatterView, nextStepNow } from "./matter-read";
import { MATTER_DIRECTIONS, readDirectionPins } from "./memory-files";

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
    told: [],
    waitingOn: [],
    with: [],
    ...over,
  }) as MatterView;

const people = {
  nameOf: (r: string) => r,
  truth: { areas: [], me: { text: "" } },
} as never;

afterEach(() => rmSync(MATTER_DIRECTIONS, { force: true }));

test("the night drafts each running matter's direction, pinned to its steps; a re-group keeps it; drafted again only on a new step or ending", async () => {
  const matters = await import("./matters");
  const models = await import("../models/llm");
  const errand = view("matter_00000000b001");
  const repair = view("matter_00000000b002");
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    errand,
    repair,
    view("matter_00000000b003", { lone: true }),
    view("matter_00000000b004", { status: "dormant" }),
    view("matter_00000000b005", { open: false }),
  ]);
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
    const pins = readDirectionPins();
    expect(pins.map((p) => [p.goal, p.nextStep?.kind, p.steps])).toEqual([
      ["The refund is paid back", "do", errand.steps.map((s) => s.ref)],
      ["Gran has her watch back", "wait_event", repair.steps.map((s) => s.ref)],
    ]);
    // A re-group: new ids, the same steps in another order: each direction follows its steps.
    const regrouped = [
      {
        ...errand,
        id: "matter_00000000c001",
        steps: errand.steps.toReversed(),
      },
      { ...repair, id: "matter_00000000c002" },
    ];
    const read = directionsOf(regrouped, pins);
    expect(read.get(regrouped[0] as MatterView)?.goal?.text).toBe(
      "The refund is paid back"
    );
    const now = regrouped.map((v) => ({ ...v, ...read.get(v) }));
    expect(dueDirectionsOf(now)).toEqual([]);
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
    expect(dueDirectionsOf(moved).map((d) => d.v.id)).toEqual([
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
  expect(directionsOf([whole], pins).get(whole)).toMatchObject({
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
  expect(directionsOf([whole], later).get(whole)).toMatchObject({
    goal: { by: "owner", text: "His goal" },
    nextStep: { by: "life", text: "Life two" },
  });
  const [left, right] = [
    { id: "matter_000000000002", steps: [{ ref: s2 }] },
    { id: "matter_000000000003", steps: [{ ref: s1 }, { ref: s3 }] },
  ];
  const split = directionsOf([left, right], pins.slice(0, 1));
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
    const read = directionsOf(book, [pin]);
    expect(read.get(mine)?.goal?.text).toBe("The parcel is home");
    expect(read.has(other)).toBe(false);
  }
  // The smaller matter's own pin stays with it, whatever the order: a tie goes to the one with the fewest steps.
  const small = { ...pin, goal: "The courier calls back", steps: [shared] };
  for (const book of [
    [other, mine],
    [mine, other],
  ]) {
    expect(directionsOf(book, [small]).get(other)?.goal?.text).toBe(
      "The courier calls back"
    );
  }
});
