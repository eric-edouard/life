import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendJsonl } from "../core/files";
import { type DirectionPin, MatterDirectionBatch } from "../records/matter";
import { Correction } from "../records/observation";
import { DIRECTIONS_PROMPT, directionDueOf } from "./matter-direction-due";
import { matterDirections } from "./matter-directions";
import {
  directionsOf,
  type MatterView,
  matterFinderOf,
  nextStepNow,
} from "./matter-read";
import { readMatterPins } from "./matters";
import { CORRECTIONS, MATTER_DIRECTIONS } from "./memory-files";

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

test("his next step with no context keeps the earlier step's context while its kind and wait stay; another kind or wait, his own context or Life's next draft replace it (life#1005)", () => {
  const steps = ["obs_000000000001", "unit_000000000002"];
  const v = { id: "matter_000000000001", steps: steps.map((ref) => ({ ref })) };
  let hour = 0;
  const nextHour = () => {
    hour += 1;
    return new Date(Date.UTC(2026, 10, 10, hour)).toISOString();
  };
  const pin = (by: "life" | "owner", nextStep: DirectionPin["nextStep"]) => ({
    at: nextHour(),
    by,
    ...(by === "life" ? { goal: "The strap is mended" } : {}),
    nextStep,
    steps,
  });
  const why = "The shop [quoted it](life:obs_000000000001).";
  const drafted = pin("life", {
    context: why,
    kind: "do",
    text: "Ask the shop",
  });
  const stepOf = (...pins: DirectionPin[]) =>
    directionsOf(matterFinderOf([v]), [drafted, ...pins]).get(v)?.nextStep;
  const reworded = pin("owner", { kind: "do", text: "Ask the shop today" });
  expect(stepOf(reworded)).toMatchObject({ by: "owner", context: why });
  expect(
    stepOf(reworded, pin("owner", { kind: "do", text: "Ask them by mail" }))
  ).toMatchObject({ context: why });
  const waiting = pin("owner", {
    kind: "wait_event",
    text: "The shop's answer",
    waitsOn: "the shop",
  });
  expect(stepOf(waiting)?.context).toBeUndefined();
  expect(
    stepOf(reworded, waiting, pin("owner", { kind: "do", text: "Ask again" }))
      ?.context
  ).toBeUndefined();
  const waited = pin("life", {
    context: why,
    kind: "wait_event",
    text: "The shop's answer",
    waitsOn: "the shop",
  });
  expect(
    stepOf(
      waited,
      pin("owner", {
        kind: "wait_event",
        text: "The answer",
        waitsOn: "the shop",
      })
    )
  ).toMatchObject({ context: why, text: "The answer" });
  expect(
    stepOf(
      waited,
      pin("owner", {
        kind: "wait_event",
        text: "The parcel",
        waitsOn: "the post",
      })
    )?.context
  ).toBeUndefined();
  const his = "Kit said [it is ready](life:unit_000000000002).";
  expect(
    stepOf(pin("owner", { context: his, kind: "do", text: "Pick it up" }))
  ).toMatchObject({ context: his });
  const redrafted = stepOf(reworded, pin("life", { kind: "do", text: "Go" }));
  expect([redrafted?.by, redrafted?.context]).toEqual(["life", undefined]);
  expect(
    directionsOf(matterFinderOf([v]), [
      pin("owner", { kind: "do", text: "Ask the shop" }),
    ]).get(v)?.nextStep?.context
  ).toBeUndefined();
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
  prompt: DIRECTIONS_PROMPT,
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

test("a Life draft of an older directions prompt is due once; a dormant matter holding an open step of his is due like a running one (stale-next-step-old-prompt-dormant)", () => {
  const old = { laterShown: [], prompt: "memory-matter-directions.v2" };
  const v = waiting("00000000e101");
  expect(dueIds([v], [pinOf(v, old)])).toEqual([v.id]);
  expect(dueIds([v], [pinOf(v, { laterShown: [] })])).toEqual([]);
  // His own word is never drafted over for a prompt change.
  expect(dueIds([v], [pinOf(v, { ...old, by: "owner" })])).toEqual([]);
  // Quiet three weeks, still owing a payment: its old draft (asking for an invoice that came) is drafted again, once.
  const owed = step("obs_00000000e102", "2026-10-20T09:00:00.000Z");
  const dormant = view("matter_00000000e102", {
    goal: { at: "2026-11-01T02:00:00.000Z", by: "life", text: "Paid" },
    openSteps: [owed],
    status: "dormant",
    steps: [owed],
  });
  expect(dueIds([dormant], [pinOf(dormant, old)])).toEqual([dormant.id]);
  expect(dueIds([dormant], [pinOf(dormant, { laterShown: [] })])).toEqual([]);
  // Nothing of his open: it stays undrafted.
  const theirs = { ...dormant, openSteps: [wait("obs_00000000e103")] };
  expect(dueIds([theirs], [pinOf(theirs, old)])).toEqual([]);
});

test("an open step's date passing after the latest pin makes the matter due once, his pin too; a date passed before it does not (his rule of 21 Nov 2026)", () => {
  const dated = step("obs_00000000e101", "2026-11-16T09:00:00.000Z", {
    when: "2026-11-19",
  });
  const v = view("matter_00000000e101", {
    goal: { at: "2026-11-17T02:00:00.000Z", by: "life", text: "Done" },
    openSteps: [dated],
    status: "stuck",
    steps: [dated],
  });
  const drafted = pinOf(v, { laterShown: [] });
  expect(dueIds([v], [drafted], [], "2026-11-19")).toEqual([]);
  expect(dueIds([v], [drafted], [], "2026-11-20")).toEqual([v.id]);
  expect(dueIds([v], [pinOf(v, { by: "owner" })], [], "2026-11-20")).toEqual([
    v.id,
  ]);
  // Drafted again once the date passed: nothing new.
  const again = pinOf(v, { at: "2026-11-20T02:00:00.000Z", laterShown: [] });
  expect(dueIds([v], [again], [], "2026-11-25")).toEqual([]);
  // A step that ended is not looked into again for its date.
  const ended = {
    ...v,
    openSteps: [],
    steps: [
      { ...dated, ending: { at: "2026-11-16T12:00:00.000Z", by: "todo_item" } },
    ],
  } as MatterView;
  expect(
    dueIds([ended], [pinOf(ended, { laterShown: [] })], [], "2026-11-20")
  ).toEqual([]);
});

test("his next step after Life read a matter over brings his move back: the latest pin is his, with no endingRecords", () => {
  const v = waiting("00000000e201");
  const over = pinOf(v, {
    endingRecords: [],
    laterShown: [],
    nextStep: undefined,
  });
  const his = pinOf(v, {
    at: "2026-11-18T09:00:00.000Z",
    by: "owner",
    nextStep: { kind: "do", text: "Call Sam" },
  });
  const find = matterFinderOf([v]);
  expect(directionsOf(find, [over]).get(v)?.latest?.endingRecords).toEqual([]);
  expect(
    directionsOf(find, [over, his]).get(v)?.latest?.endingRecords
  ).toBeUndefined();
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

// life#817: Life's draft carries a context, kept only when it links its own matter's shown ids and quotes nothing; else the context goes, its next step stays.
test("a drafted context links only its matter's shown ids and quotes nothing, or only the context is dropped", async () => {
  const matters = await import("./matters");
  const models = await import("../models/llm");
  const a = waiting("00000000e004");
  const b = waiting("00000000e005");
  const book = spyOn(matters, "readMatterBookAndRecords").mockResolvedValue({
    book: [a, b],
    records: recordsOf([], []),
  } as never);
  const draft = (matter: string, context: string) => ({
    goal: "Sam answers",
    matter,
    nextStep: { context, kind: "do", text: "Ask Sam again" },
  });
  const ask = spyOn(models, "askOnce").mockResolvedValue({
    directions: [
      // Its own step, never in any index: kept.
      draft(
        "m1",
        "Sam has not [answered](life:obs_00000000e004) since the 16th."
      ),
      // The other matter's step: dropped.
      draft("m2", "See [this](life:obs_00000000e004)."),
    ],
  } as never);
  try {
    rmSync(MATTER_DIRECTIONS, { force: true });
    await matterDirections(people, { all: true, today: TODAY });
    // The call is shown each step's id to link.
    expect(JSON.stringify(ask.mock.calls[0])).toContain(
      `"id":"obs_00000000e005"`
    );
    const next = () => readMatterPins().directions.map((d) => d.nextStep);
    expect(next()).toEqual([
      {
        context:
          "Sam has not [answered](life:obs_00000000e004) since the 16th.",
        kind: "do",
        text: "Ask Sam again",
      },
      { kind: "do", text: "Ask Sam again" },
    ]);
    // A quote the call made up: dropped too.
    ask.mockResolvedValue({
      directions: [
        draft("m1", "> The parcel arrived\n*[Sam](life:obs_00000000e004)*"),
      ],
    } as never);
    rmSync(MATTER_DIRECTIONS, { force: true });
    await matterDirections(people, { all: true, today: TODAY });
    expect(next()[0]).toEqual({ kind: "do", text: "Ask Sam again" });
    // So is one inline, and a sibling's id behind an image (the phone opens it as a link).
    ask.mockResolvedValue({
      directions: [
        draft(
          "m1",
          "Sam said “The parcel arrived” [here](life:obs_00000000e004)."
        ),
        draft("m2", "![record](life:obs_00000000e004)"),
      ],
    } as never);
    rmSync(MATTER_DIRECTIONS, { force: true });
    await matterDirections(people, { all: true, today: TODAY });
    expect(next()).toEqual([
      { kind: "do", text: "Ask Sam again" },
      { kind: "do", text: "Ask Sam again" },
    ]);
  } finally {
    book.mockRestore();
    ask.mockRestore();
  }
});

test("a matter's evidence is shown; a looks-over draft may cite a unit or a payment, only the unit is stored, and a context links a unit, never a payment (his pass of 21 Nov 2026)", async () => {
  const matters = await import("./matters");
  const models = await import("../models/llm");
  const evidence = await import("./matter-evidence");
  const v = waiting("00000000e004");
  const receipt = "unit_receipt000001";
  const book = spyOn(matters, "readMatterBookAndRecords").mockResolvedValue({
    book: [v],
    records: recordsOf([]),
  } as never);
  const read = spyOn(evidence, "readEvidence").mockResolvedValue(
    new Map([
      [
        v.id,
        {
          payments: [
            { day: "2026-11-17", id: "pay-1", text: "-€65 Hosting Inc" },
          ],
          units: [
            {
              day: "2026-11-17",
              id: receipt,
              source: "mail" as const,
              title: "Your receipt from Hosting Inc",
            },
          ],
        },
      ],
    ])
  );
  const ask = spyOn(models, "askOnce").mockResolvedValue({
    directions: [
      {
        endingRecords: [receipt, "pay-1"],
        goal: "The invoice is paid",
        matter: "m1",
      },
    ],
  } as never);
  try {
    await matterDirections(people, { today: TODAY });
    expect(JSON.stringify(ask.mock.calls[0])).toContain(receipt);
    expect(JSON.stringify(ask.mock.calls[0])).toContain("Hosting Inc");
    expect(readMatterPins().directions[0]?.endingRecords).toEqual([receipt]);
    // A context may link the unit it was shown, never a payment (no ref opens one).
    for (const [link, kept] of [
      [receipt, true],
      ["pay-1", false],
    ] as const) {
      rmSync(MATTER_DIRECTIONS, { force: true });
      ask.mockResolvedValue({
        directions: [
          {
            goal: "The invoice is paid",
            matter: "m1",
            nextStep: {
              context: `Seen in [the mail](life:${link}).`,
              kind: "do",
              text: "Check the invoice",
            },
          },
        ],
      } as never);
      // biome-ignore lint/performance/noAwaitInLoops: each draft is read back before the next is written
      await matterDirections(people, { today: TODAY });
      expect(
        readMatterPins().directions[0]?.nextStep?.context !== undefined
      ).toBe(kept);
    }
  } finally {
    book.mockRestore();
    read.mockRestore();
    ask.mockRestore();
  }
});

// His yes of 22 Nov 2026: his Reopen of a closed matter (`matter-reopened`) lifts Life's reading it over before it.
test("a Life draft reading a matter over before his Reopen of its steps is dropped; one after it stands", () => {
  const over = (at: string) => ({
    at,
    directions: [
      {
        endingRecords: [],
        goal: "Parcel collected",
        steps: ["obs_000000000001"],
      },
    ],
    madeBy: {
      engine: "claude" as const,
      model: "m",
      prompt: "memory-matter-directions.v3",
      run: "r",
    },
    schemaVersion: 1 as const,
  });
  try {
    appendJsonl(MATTER_DIRECTIONS, MatterDirectionBatch, [
      over("2026-11-20T02:00:00.000Z"),
    ]);
    appendJsonl(CORRECTIONS, Correction, [
      {
        at: "2026-11-21T10:00:00.000Z",
        kind: "matter-reopened",
        matter: "matter_000000000001",
        schemaVersion: 1,
        steps: ["obs_000000000001"],
      },
    ]);
    expect(readMatterPins().directions).toEqual([]);
    appendJsonl(MATTER_DIRECTIONS, MatterDirectionBatch, [
      over("2026-11-22T02:00:00.000Z"),
    ]);
    expect(readMatterPins().directions).toMatchObject([
      { at: "2026-11-22T02:00:00.000Z", by: "life" },
    ]);
  } finally {
    rmSync(CORRECTIONS, { force: true });
  }
});
