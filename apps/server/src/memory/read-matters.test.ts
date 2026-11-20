import { expect, spyOn, test } from "bun:test";
import { INFERRED_PREFIX } from "../records/observation";
import {
  dismissedIdsOf,
  type HandOutFacts,
  type HandOutMatter,
  handOutGateOf,
  isOneOfHis,
  isParkedMatterOf,
  needsYouOf,
  oneMatter,
  openMatters,
} from "./read-matters";
import { guessTestOf } from "./who";

test("read_matters lists the open matters, of one project when asked; read_matter opens one with its steps", async () => {
  const who = await import("./who");
  const matters = await import("./matters");
  const items = await import("./read-open-items");
  const rank = spyOn(items, "rankContextOf").mockReturnValue({
    goals: [],
    levels: new Map(),
  });
  const step = (kind: string, text: string, day: string, ref: string) => ({
    at: `${day}T10:00:00.000Z`,
    day,
    kind,
    quote: `"${text}" said Gran`,
    ref,
    text,
  });
  const view = (over: object) => ({
    areas: [],
    lone: false,
    open: true,
    openSteps: [],
    owedTo: [],
    projects: [],
    waitingOn: [],
    with: [],
    ...over,
  });
  const steps = [
    step("episode", "Gran's watch", "2026-10-02", "ep_000000000001"),
    {
      ...step("promise", "Call the shop", "2026-10-12", "obs_000000000005"),
      with: "person:partner",
    },
  ];
  const errand = view({
    goal: {
      at: "2026-10-13T02:00:00.000Z",
      by: "life",
      text: "Gran has her watch back",
    },
    id: "matter_aaaaaaaaaaaa",
    name: "Mend Gran's watch",
    newestOpenStep: steps[1],
    nextStep: {
      at: "2026-10-13T09:00:00.000Z",
      by: "owner",
      kind: "wait_event",
      text: "The shop's quote",
      waitsOn: "the shop",
    },
    owedTo: ["person:gran"],
    projects: ["shop-fit-out"],
    status: "moving",
    steps,
    with: ["person:partner"],
  });
  const other = view({
    id: "matter_bbbbbbbbbbbb",
    name: "Renew the lease",
    newestOpenStep: step(
      "waiting_on_someone",
      "Landlord's reply",
      "2026-10-01",
      "obs_000000000009"
    ),
    status: "waiting_on_someone",
    steps: [],
    waitingOn: ["person:shop"],
  });
  const people = spyOn(who, "readPeople").mockResolvedValue({
    isGuess: () => false,
    nameOf: (r: string) => r.replace("person:", ""),
    truth: {
      areas: [],
      projects: [
        { id: "shop-fit-out", name: "Shop fit-out", status: "active" },
      ],
    },
  } as never);
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    other,
    errand,
    {
      ...view({ id: "matter_cccccccccccc", name: "Old", steps: [] }),
      open: false,
      status: "done",
    },
  ] as never);
  try {
    const all = (await openMatters({})).matters;
    // Ranked, not newest first: a promise owed comes before a wait, though the wait is older; a done one is not running.
    expect(all.map((m) => m.id)).toEqual([
      "matter_aaaaaaaaaaaa",
      "matter_bbbbbbbbbbbb",
    ]);
    const row = {
      goal: { by: "life", text: "Gran has her watch back" },
      id: "matter_aaaaaaaaaaaa",
      lastStepAt: "2026-10-12T10:00:00.000Z",
      name: "Mend Gran's watch",
      newestOpenStep: { day: "2026-10-12", text: "Call the shop" },
      nextStep: {
        by: "owner",
        kind: "wait_event",
        text: "The shop's quote",
        waitsOn: "the shop",
      },
      people: {
        owedTo: ["gran"],
        with: ["partner"],
      },
      projects: ["Shop fit-out"],
      status: "moving",
    };
    // Empty fields are left out of the JSON a model reads.
    expect(JSON.parse(JSON.stringify(all[0]))).toEqual(row);
    expect(all[1]?.people?.waitingOn).toEqual(["shop"]);
    expect(
      (await openMatters({ project: "Shop fit-out" })).matters.map((m) => m.id)
    ).toEqual(["matter_aaaaaaaaaaaa"]);
    await expect(openMatters({ project: "Nowhere" })).rejects.toThrow(
      "No project goes by that name."
    );
    const one = await oneMatter(["matter_aaaaaaaaaaaa"]);
    // A step's company by name, as the row's people.
    expect(JSON.parse(JSON.stringify(one))).toEqual({
      ...row,
      agents: [],
      communicationStyles: [],
      steps: [steps[0], { ...steps[1], with: "partner" }],
    });
    // A step's id opens the matter holding it; anchors find it by the first that still names a step.
    expect(await oneMatter(["obs_000000000005"])).toEqual(one);
    expect(await oneMatter(["obs_gone", "obs_000000000005"])).toEqual(one);
    expect(await oneMatter(["matter_zzzzzzzzzzzz"])).toBeUndefined();
    // Host's agents on it and its active agent, given the matter's steps.
    expect(
      (
        await oneMatter(["matter_aaaaaaaaaaaa"], (refs, projects) =>
          refs.includes("obs_000000000005") && projects.includes("shop-fit-out")
            ? [{ id: "agt_000000000001" }]
            : []
        )
      )?.agents
    ).toEqual([{ id: "agt_000000000001" }]);
    expect(
      (
        await openMatters({}, (refs, projects) =>
          refs.includes("ep_000000000001") || projects.includes("shop-fit-out")
            ? "agt_000000000001"
            : undefined
        )
      ).matters[0]?.agent
    ).toBe("agt_000000000001");
  } finally {
    people.mockRestore();
    book.mockRestore();
    rank.mockRestore();
  }
});

// A matter of his (his word of 20 Nov 2026): someone he knows, or a step he said himself.
const gone = { hasOwnOpenStep: false, owedTo: [], waitingOn: [], with: [] };
const isGuess = guessTestOf(
  [],
  [{ confidence: 0.8, id: `${INFERRED_PREFIX}ana`, isOrganization: false }]
);

test("a matter made only of an unknown sender's words is not one of his", () => {
  expect(
    isOneOfHis({ ...gone, owedTo: ["unknown:stranger@example.test"] }, isGuess)
  ).toBe(false);
});

test("the same matter with a step he said himself is", () => {
  expect(
    isOneOfHis(
      {
        ...gone,
        hasOwnOpenStep: true,
        owedTo: ["unknown:stranger@example.test"],
      },
      isGuess
    )
  ).toBe(true);
});

test("a matter with a person of his directory or of his Contacts is; a person only guessed is not", () => {
  // Directory and Contacts people are `person:<id>` without Life's inferred prefix: no guess.
  expect(isOneOfHis({ ...gone, with: ["person:test-bea"] }, isGuess)).toBe(
    true
  );
  expect(
    isOneOfHis({ ...gone, waitingOn: ["person:card-cleo"] }, isGuess)
  ).toBe(true);
  expect(
    isOneOfHis({ ...gone, with: [`person:${INFERRED_PREFIX}ana`] }, isGuess)
  ).toBe(false);
});

// What needs him, moved from the phone's Kit (its tests of the rule).
test("a matter needs him when its next step is his decision or only his to do, unless stuck, or a check about it blocks him", () => {
  const next = (kind: string) => ({ nextStep: { kind }, status: "moving" });
  expect(needsYouOf(next("do"), 1)).toBe(true);
  expect(needsYouOf(next("wait_owner"), 0)).toBe(true);
  expect(needsYouOf(next("wait_decision"), 0)).toBe(true);
  expect(needsYouOf(next("do"), 0)).toBe(false);
  expect(needsYouOf(next("wait_event"), 0)).toBe(false);
  expect(needsYouOf({ status: "moving" }, 0)).toBe(false);
  // A stuck matter is stuck whatever its next step says; a blocking check still counts.
  expect(
    needsYouOf({ nextStep: { kind: "wait_owner" }, status: "stuck" }, 0)
  ).toBe(false);
  expect(
    needsYouOf({ nextStep: { kind: "wait_owner" }, status: "stuck" }, 1)
  ).toBe(true);
});

// The hand-out's gates, in order. Made-up matters.
const matterOf = (id: string, over: Partial<HandOutMatter> = {}) =>
  ({
    id,
    nextStep: { kind: "do", text: "Do it" },
    projects: [],
    steps: [{ at: "2026-11-18T09:00:00.000Z", ref: `obs_${id}` }],
    ...over,
  }) as unknown as HandOutMatter;
const open: HandOutFacts = {
  decisions: [],
  dismissed: new Set(),
  isDue: () => false,
  isHeld: () => undefined,
  isHis: () => true,
  isParked: () => false,
};
const gate = (over: Partial<HandOutFacts>, v = matterOf("m1")) =>
  handOutGateOf(v, { ...open, ...over });

test("a matter that passes every gate has none", () => {
  expect(gate({})).toBeNull();
});

test("each gate names itself, in order: not_do, project_parked, direction_due, dismissed, held, not_his", () => {
  const all = {
    dismissed: new Set(["m1"]),
    isDue: () => true,
    isHeld: () => ({}) as never,
    isHis: () => false,
    isParked: () => true,
  };
  const wait = matterOf("m1", { nextStep: { kind: "wait_event" } as never });
  expect(gate(all, wait)).toBe("not_do");
  expect(gate(all)).toBe("project_parked");
  expect(gate({ ...all, isParked: () => false })).toBe("direction_due");
  expect(gate({ ...all, isDue: () => false, isParked: () => false })).toBe(
    "dismissed"
  );
  expect(
    gate({
      ...all,
      dismissed: new Set(),
      isDue: () => false,
      isParked: () => false,
    })
  ).toBe("held");
  expect(gate({ isHis: () => false })).toBe("not_his");
  // An open decision on one of its steps makes its next step his decision: not to do.
  expect(gate({ decisions: [{ question: "Which?", subject: "obs_m1" }] })).toBe(
    "not_do"
  );
});

test("the dismissed ones are found over the whole book, by the steps they were pinned to", () => {
  const book = [matterOf("m1"), matterOf("m2")];
  expect([...dismissedIdsOf(book, [["obs_m2"], ["obs_gone"]])]).toEqual(["m2"]);
});

test("a matter is parked when it has projects and none is underway; one with no project, or one underway, is not", () => {
  const truth = {
    projects: [
      { id: "shop", status: "parked" },
      { id: "farm", status: "done" },
      { id: "bakery", status: "waiting" },
    ],
  } as never;
  const isParked = isParkedMatterOf(truth);
  expect(isParked({ projects: ["shop"] })).toBe(true);
  expect(isParked({ projects: ["shop", "farm"] })).toBe(true);
  expect(isParked({ projects: ["shop", "bakery"] })).toBe(false);
  expect(isParked({ projects: [] })).toBe(false);
});

test("a matter of a parked project ranks after every other, each half keeping its order", async () => {
  const who = await import("./who");
  const matters = await import("./matters");
  const items = await import("./read-open-items");
  const rank = spyOn(items, "rankContextOf").mockReturnValue({
    goals: [],
    levels: new Map(),
  });
  const view = (id: string, projects: string[], day: string) => ({
    areas: [],
    id,
    lone: false,
    name: id,
    newestOpenStep: {
      at: `${day}T10:00:00.000Z`,
      day,
      kind: "promise",
      quote: "q",
      ref: `obs_${id}`,
      text: id,
    },
    open: true,
    openSteps: [],
    owedTo: ["person:gran"],
    projects,
    status: "moving",
    steps: [],
    waitingOn: [],
    with: [],
  });
  const people = spyOn(who, "readPeople").mockResolvedValue({
    nameOf: (r: string) => r,
    truth: {
      areas: [],
      projects: [
        { id: "shop", name: "Shop", status: "parked" },
        { id: "farm", name: "Farm", status: "active" },
      ],
    },
  } as never);
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    view("newest-parked", ["shop"], "2026-10-12"),
    view("plain", [], "2026-10-11"),
    view("mixed", ["shop", "farm"], "2026-10-10"),
  ] as never);
  try {
    expect((await openMatters({})).matters.map((m) => m.id)).toEqual([
      "plain",
      "mixed",
      "newest-parked",
    ]);
  } finally {
    people.mockRestore();
    book.mockRestore();
    rank.mockRestore();
  }
});
