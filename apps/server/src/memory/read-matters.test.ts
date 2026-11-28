import { expect, spyOn, test } from "bun:test";
import { INFERRED_PREFIX } from "../records/observation";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as icons from "./matter-icons";
import { dismissedIdsOf } from "./matter-pins";
import { matterFinderOf } from "./matter-read";
import {
  type HandOutFacts,
  type HandOutMatter,
  handOutGateOf,
  isInScope,
  isOneOfHis,
  isParkedMatterOf,
  namedIdOf,
  needsYouOf,
  oneMatter,
  openMatters,
  projectOf,
  readMatterProjectIds,
} from "./read-matters";
import { knownTestOf } from "./ref-kinds";

/** A made-up party, named by its id. */
const party = (ref: string) => ({
  kind: "person" as const,
  name: ref.replace("person:", ""),
  ref,
});

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
    isKnownToHim: () => true,
    nameOf: (r: string) => r.replace("person:", ""),
    partyOf: (r: string) => party(r),
    truth: {
      areas: [],
      me: { goals: "1. Open the shop by May (`shop-fit-out`).", text: "" },
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
      openedAt: "2026-10-02T10:00:00.000Z",
      people: {
        owedTo: [party("person:gran")],
        with: [party("person:partner")],
      },
      project: { id: "shop-fit-out", name: "Shop fit-out", status: "active" },
      projects: ["Shop fit-out"],
      status: "moving",
    };
    // Empty fields are left out of the JSON a model reads.
    expect(JSON.parse(JSON.stringify(all[0]))).toEqual(row);
    expect(all[1]?.people?.waitingOn).toEqual([party("person:shop")]);
    const page = await openMatters({ project: "Shop fit-out" });
    expect(page.matters.map((m) => m.id)).toEqual(["matter_aaaaaaaaaaaa"]);
    // Its page's head: the first of his goals naming it, in his words; underway, no parked count.
    expect(JSON.parse(JSON.stringify(page.project))).toEqual({
      goal: "Open the shop by May.",
      id: "shop-fit-out",
      name: "Shop fit-out",
      situation: [],
      status: "active",
    });
    expect((await openMatters({})).project).toBeUndefined();
    await expect(openMatters({ project: "Nowhere" })).rejects.toThrow(
      "No project goes by that name."
    );
    const one = await oneMatter(["matter_aaaaaaaaaaaa"]);
    // A step's company as a party, as the row's people.
    expect(JSON.parse(JSON.stringify(one))).toEqual({
      ...row,
      agents: [],
      communicationStyles: [],
      situation: [],
      steps: [steps[0], { ...steps[1], with: party("person:partner") }],
    });
    // A step's id opens the matter holding it; anchors find it by the first that still names a step.
    expect(await oneMatter(["obs_000000000005"])).toEqual(one);
    expect(await oneMatter(["obs_gone", "obs_000000000005"])).toEqual(one);
    expect(await oneMatter(["matter_zzzzzzzzzzzz"])).toBeUndefined();
    // The packet reads the matter's projects by id (the row names them).
    expect(await readMatterProjectIds(["obs_000000000005"])).toEqual([
      "shop-fit-out",
    ]);
    expect(await readMatterProjectIds(["matter_zzzzzzzzzzzz"])).toEqual([]);
    // Host's agents on it, given the matter's steps.
    expect(
      (
        await oneMatter(["matter_aaaaaaaaaaaa"], {
          agentsOf: (refs) =>
            refs.includes("obs_000000000005")
              ? [{ id: "agt_000000000001" }]
              : [],
        })
      )?.agents
    ).toEqual([{ id: "agt_000000000001" }]);
    expect(
      (
        await openMatters({}, (refs) =>
          refs.includes("ep_000000000001") ? "agt_000000000001" : undefined
        )
      ).matters[0]?.agent
    ).toBe("agt_000000000001");
    // Icons, on a project's read too: his pick wins over Life's stored one; Life's shows for the other.
    book.mockResolvedValue([
      { ...errand, ownerIcon: "tools" },
      { ...other, projects: ["shop-fit-out"] },
    ] as never);
    const picks = spyOn(icons, "readLifeIcons").mockReturnValue(
      new Map([
        [icons.iconInputsOf(errand as never), "gift"],
        [icons.iconInputsOf(other as never), "home"],
      ])
    );
    const his = { by: "owner", key: "tools" } as const;
    expect(
      (await openMatters({ project: "shop-fit-out" })).matters.map(
        (m) => m.icon
      )
    ).toEqual([his, { by: "life", key: "home" }]);
    expect((await oneMatter(["matter_aaaaaaaaaaaa"]))?.icon).toEqual(his);
    picks.mockRestore();
  } finally {
    people.mockRestore();
    book.mockRestore();
    rank.mockRestore();
  }
});

// A matter of his (his word of 20 Nov 2026): someone he knows, or a step he said himself.
const gone = { hasOwnOpenStep: false, owedTo: [], waitingOn: [], with: [] };
const known = {
  isKnownToHim: knownTestOf([
    {
      at: "2026-11-20T09:00:00.000Z",
      kind: "this-is",
      nameOrHandle: "Dee",
      person: `person:${INFERRED_PREFIX}dee`,
      schemaVersion: 1,
    },
  ]),
};

test("a matter made only of an unknown sender's words is not one of his", () => {
  expect(
    isOneOfHis({ ...gone, owedTo: ["unknown:stranger@example.test"] }, known)
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
      known
    )
  ).toBe(true);
});

test("a matter with a person or an organization of his directory or of his Contacts is; one only Life inferred is not, unless his word named it", () => {
  // Directory people and organizations, and Contacts people, are `person:<id>` without Life's inferred prefix.
  expect(isOneOfHis({ ...gone, with: ["person:test-bea"] }, known)).toBe(true);
  expect(isOneOfHis({ ...gone, owedTo: ["person:test-bakery"] }, known)).toBe(
    true
  );
  expect(isOneOfHis({ ...gone, waitingOn: ["person:card-cleo"] }, known)).toBe(
    true
  );
  // Inferred, however sure, or an organization Life settled on its own (a promotional sender): not his.
  expect(
    isOneOfHis({ ...gone, with: [`person:${INFERRED_PREFIX}ana`] }, known)
  ).toBe(false);
  expect(
    isOneOfHis(
      { ...gone, owedTo: [`person:${INFERRED_PREFIX}promo-shop`] },
      known
    )
  ).toBe(false);
  // His `this-is` to an inferred one makes it someone he knows.
  expect(
    isOneOfHis({ ...gone, with: [`person:${INFERRED_PREFIX}dee`] }, known)
  ).toBe(true);
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
  agentFor: () => "agt_000000000001",
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

// Card sort (28 Nov 2026): his own work done elsewhere, or someone else's, is never handed to an agent; no reading, no gate.
test("a matter whose your move card is hidden is not handed out, after a hands-off project and before a due direction", () => {
  expect(gate({ isMoveHidden: () => true })).toBe("move_hidden");
  expect(gate({ isHandsOff: () => true, isMoveHidden: () => true })).toBe(
    "hands_off"
  );
  expect(gate({ isDue: () => true, isMoveHidden: () => true })).toBe(
    "move_hidden"
  );
  expect(gate({ isMoveHidden: () => false })).toBeNull();
});

test("each gate names itself, in order: not_do, project_parked, direction_due, dismissed, held, not_his, no_agent", () => {
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
  expect(gate({ agentFor: () => undefined, isHis: () => false })).toBe(
    "not_his"
  );
  expect(gate({ agentFor: () => undefined })).toBe("no_agent");
  // An open decision on one of its steps makes its next step his decision: not to do.
  expect(gate({ decisions: [{ question: "Which?", subject: "obs_m1" }] })).toBe(
    "not_do"
  );
});

test("the dismissed ones are found over the whole book, by the steps they were pinned to", () => {
  const book = [matterOf("m1"), matterOf("m2")];
  expect([
    ...dismissedIdsOf(matterFinderOf(book), [["obs_m2"], ["obs_gone"]]),
  ]).toEqual(["m2"]);
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
  // One project his directory does not hold: the matter shows under the one it does (`projectOf`), parked.
  expect(isParked({ projects: ["ghost", "shop"] })).toBe(true);
  expect(isParked({ projects: ["ghost"] })).toBe(false);
  // It shows under the one underway, else its first.
  expect(projectOf(truth)({ projects: ["shop", "bakery"] })?.id).toBe("bakery");
  expect(projectOf(truth)({ projects: ["farm", "shop"] })?.id).toBe("farm");
  expect(projectOf(truth)({ projects: ["ghost"] })).toBeUndefined();
});

test("a matter he marked important comes first, with no open step too; its parked project still sinks it, first of the parked; a parked project's page counts its matters that wait", async () => {
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
    partyOf: party,
    truth: {
      areas: [],
      me: { text: "" },
      projects: [
        { id: "shop", name: "Shop", status: "parked" },
        { id: "farm", name: "Farm", status: "active" },
      ],
    },
  } as never);
  const marked = (v: ReturnType<typeof view>) => ({ ...v, important: true });
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    view("newest-parked", ["shop"], "2026-10-12"),
    view("plain", [], "2026-10-11"),
    view("mixed", ["shop", "farm"], "2026-10-10"),
    marked(view("marked-parked", ["shop"], "2026-10-09")),
    {
      ...marked(view("marked-quiet", [], "2026-10-08")),
      newestOpenStep: undefined,
    },
  ] as never);
  try {
    const all = (await openMatters({})).matters;
    expect(all.map((m) => m.id)).toEqual([
      "marked-quiet",
      "plain",
      "mixed",
      "marked-parked",
      "newest-parked",
    ]);
    expect(all.map((m) => [m.important, m.project?.id])).toEqual([
      [true, undefined],
      [undefined, undefined],
      [undefined, "farm"],
      [true, "shop"],
      [undefined, "shop"],
    ]);
    expect((await openMatters({ project: "shop" })).project).toEqual({
      goal: undefined,
      id: "shop",
      name: "Shop",
      situation: [],
      status: "parked",
    });
  } finally {
    people.mockRestore();
    book.mockRestore();
    rank.mockRestore();
  }
});

test("a scope holds the matters of an area, of a project, or of an area in no project: the one rule of the list and the chips' counts", () => {
  const truth = {
    projects: [{ id: "shop" }, { id: "old" }],
  } as unknown as Parameters<typeof isInScope>[0];
  const home = { areas: ["home"], projects: [] as string[] };
  const homeShop = { areas: ["home"], projects: ["shop"] };
  const work = { areas: ["work"], projects: [] as string[] };
  const unknown = { areas: ["home"], projects: ["not-in-directory"] };
  const all = [home, homeShop, work, unknown];
  const of = (s: Parameters<typeof isInScope>[1]) =>
    all.filter(isInScope(truth, s));
  expect(of({})).toEqual(all);
  expect(of({ area: "home" })).toEqual([home, homeShop, unknown]);
  expect(of({ project: "shop" })).toEqual([homeShop]);
  expect(of({ area: "home", noProject: true })).toEqual([home, unknown]);
});

test("a project is found by its id or its name, accents and case aside", () => {
  const list = [{ id: "cafe-co", name: "Café Co" }];
  expect(namedIdOf(list, "Cafe co")).toBe("cafe-co");
  expect(namedIdOf(list, "cafe-co")).toBe("cafe-co");
  expect(namedIdOf(list, "nope")).toBeUndefined();
  // An exact id beats another project's name that reads alike.
  const two = [
    { id: "a", name: "Cafe" },
    { id: "cafe", name: "Other" },
  ];
  expect(namedIdOf(two, "cafe")).toBe("cafe");
});
