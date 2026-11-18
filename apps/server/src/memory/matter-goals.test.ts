import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { dueGoalsOf, matterGoals } from "./matter-goals";
import { goalsOf, type MatterView } from "./matter-read";
import { MATTER_GOALS, readGoalPins } from "./memory-files";

const TODAY = "2026-11-18";

const view = (id: string, day: string, over: Partial<MatterView> = {}) =>
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
      {
        at: `${day}T09:00:00.000Z`,
        day,
        kind: "to_do",
        quote: "fix it",
        ref: `obs_${id.slice(-4).padStart(12, "0")}`,
        text: `Fix ${id}`,
      },
      {
        at: `${day}T10:00:00.000Z`,
        day,
        kind: "episode",
        quote: "called",
        ref: `unit_${id.slice(-4).padStart(12, "0")}`,
        text: `Called about ${id}`,
      },
    ],
    told: [],
    waitingOn: [],
    with: [],
    ...over,
  }) as MatterView;

afterEach(() => rmSync(MATTER_GOALS, { force: true }));

test("a goal is due for a new, open, grouped matter with none: never an old one, a matter of one, a closed one or one with a goal", () => {
  const due = dueGoalsOf(
    [
      view("matter_00000000a001", "2026-11-17"),
      view("matter_00000000a002", "2026-10-01"),
      view("matter_00000000a003", "2026-11-17", { lone: true }),
      view("matter_00000000a004", "2026-11-17", { open: false }),
      view("matter_00000000a005", "2026-11-17", {
        goal: { by: "owner", text: "Done" },
      }),
    ],
    TODAY
  );
  expect(due.map((v) => v.id)).toEqual(["matter_00000000a001"]);
});

test("the night drafts each due matter's goal once, pinned to its steps: a re-group keeps it, an unasked or bad reply is dropped", async () => {
  const matters = await import("./matters");
  const models = await import("../models/llm");
  const errand = view("matter_00000000b001", "2026-11-16");
  const repair = view("matter_00000000b002", "2026-11-17");
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    errand,
    repair,
  ]);
  const ask = spyOn(models, "askOnce").mockResolvedValue({
    goals: [
      { agentCanMove: true, goal: "The refund is paid back", matter: "m1" },
      { agentCanMove: false, goal: "Gran has her watch back", matter: "m2" },
      { agentCanMove: true, goal: "Never asked", matter: "m9" },
      { goal: "No verdict", matter: "m1" },
    ],
  } as never);
  try {
    const people = {
      nameOf: (r: string) => r,
      truth: { areas: [], me: { text: "" } },
    } as never;
    expect(await matterGoals(people, TODAY)).toMatchObject({
      drafted: 2,
      due: 2,
    });
    const pins = readGoalPins();
    expect(pins.map((p) => [p.text, p.agentCanMove, p.steps])).toEqual([
      ["The refund is paid back", true, errand.steps.map((s) => s.ref)],
      ["Gran has her watch back", false, repair.steps.map((s) => s.ref)],
    ]);
    // A re-group: new ids, the same steps (in another order): each goal follows its steps.
    const regrouped = [
      {
        ...errand,
        id: "matter_00000000c001",
        steps: errand.steps.toReversed(),
      },
      { ...repair, id: "matter_00000000c002" },
    ];
    const goals = goalsOf(regrouped, pins);
    expect(goals.get(regrouped[0] as MatterView)?.text).toBe(
      "The refund is paid back"
    );
    // A matter with a goal is never drafted again.
    book.mockResolvedValue(
      regrouped.map((v) => ({ ...v, goal: goals.get(v) }))
    );
    expect(await matterGoals(people, TODAY)).toMatchObject({ due: 0 });
    expect(ask).toHaveBeenCalledTimes(1);
  } finally {
    book.mockRestore();
    ask.mockRestore();
  }
});

test("his goal wins over any draft, before or after; a split leaves the goal with the part holding its first pinned step", () => {
  const [s1, s2, s3] = [
    "obs_000000000001",
    "unit_000000000002",
    "obs_000000000003",
  ];
  const pin = (
    by: "life" | "owner",
    at: string,
    steps: string[],
    text: string
  ) => ({
    agentCanMove: by === "life" ? true : undefined,
    at,
    by,
    steps,
    text,
  });
  const whole = {
    id: "matter_000000000001",
    steps: [s1, s2, s3].map((ref) => ({ ref })),
  };
  const pins = [
    pin("life", "2026-11-10T02:00:00.000Z", [s1, s2, s3], "Draft one"),
    pin("owner", "2026-11-11T09:00:00.000Z", [s2], "His goal"),
    pin("life", "2026-11-12T02:00:00.000Z", [s1, s2, s3], "Draft two"),
  ];
  expect(goalsOf([whole], pins).get(whole)).toEqual({
    by: "owner",
    draft: { agentCanMove: true, at: "2026-11-12T02:00:00.000Z" },
    text: "His goal",
  });
  const [left, right] = [
    { id: "matter_000000000002", steps: [{ ref: s2 }] },
    { id: "matter_000000000003", steps: [{ ref: s1 }, { ref: s3 }] },
  ];
  const split = goalsOf([left, right], pins.slice(0, 1));
  expect(split.get(right)?.text).toBe("Draft one");
  expect(split.has(left)).toBe(false);
});
