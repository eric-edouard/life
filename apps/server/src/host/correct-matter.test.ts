import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { chosenIconsOf, importantIdsOf } from "../memory/matter-pins";
import {
  directionsOf,
  matterFinderOf,
  openStepsOf,
} from "../memory/matter-read";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matters from "../memory/matters";
import { readMatterPins } from "../memory/matters";
import { CORRECTIONS, readCorrections } from "../memory/memory-files";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as todo from "./change-todo-item";
import { endByHisWord } from "./correct-matter";
import { correct } from "./http/mcp";

// 19 Nov 2026 (review C, B7 and R1): the phone decided which steps were open and sent only its obs_ ones, so a
// matter's to-do items stayed open while it said "Marked as done", and one of to-do items only was refused.

const step = (ref: string, kind: string, ending?: object) => ({
  at: "2026-11-10T10:00:00.000Z",
  day: "2026-11-10",
  kind,
  quote: "it",
  ref,
  text: "it",
  ...(ending ? { ending } : {}),
});
const matter = {
  id: "matter_aaaaaaaaaaaa",
  name: "Mend the boiler",
  open: true,
  steps: [
    step("ep_000000000001", "episode"),
    step("obs_000000000001", "promise"),
    step("obs_000000000002", "waiting_on_someone", {
      at: "2026-11-11T10:00:00.000Z",
      by: "link",
      quote: "The plumber came.",
    }),
    step("obs_000000000003", "to_do", {
      at: "2026-11-11T10:00:00.000Z",
      by: "record",
      why: "done",
    }),
    step("entry_000000000001", "todo_item"),
  ],
};
let book: ReturnType<typeof spyOn>;
let tick: ReturnType<typeof spyOn>;
beforeEach(() => {
  rmSync(CORRECTIONS, { force: true });
  book = spyOn(matters, "readMatterBook").mockResolvedValue([matter] as never);
  tick = spyOn(todo, "tickTodoItems").mockResolvedValue([]);
});
afterEach(() => {
  book.mockRestore();
  tick.mockRestore();
  rmSync(CORRECTIONS, { force: true });
});

test("a matter marked done by its id closes every open step as Life reads it: observations outdated, to-do items ticked", async () => {
  await correct({
    correction: {
      kind: "outdated",
      matter: "matter_aaaaaaaaaaaa",
      note: "Marked done in the Life app.",
    },
    kind: "memory",
  });
  expect(tick).toHaveBeenCalledWith(
    ["entry_000000000001"],
    "Marked done in the Life app.",
    expect.any(Function)
  );
  expect(readCorrections()).toMatchObject([
    {
      kind: "outdated",
      note: "Marked done in the Life app.",
      // The step a link ended becomes his word; the one already retired, and the episode, are left.
      observations: ["obs_000000000001", "obs_000000000002"],
    },
  ]);
});

test("two to-do items ticked: a plan with a limit, one report per tick, then recorded", async () => {
  book.mockResolvedValue([
    {
      ...matter,
      steps: [...matter.steps, step("entry_000000000002", "todo_item")],
    },
  ] as never);
  tick.mockImplementation((keys: string[], _said: string, onTicked: never) => {
    for (const [i, k] of keys.entries()) {
      (onTicked as (a: number, b: number, c: string) => void)(
        i + 1,
        keys.length,
        k
      );
    }
    return Promise.resolve([]);
  });
  const reported: Record<string, unknown>[] = [];
  await correct(
    {
      correction: { kind: "outdated", matter: "matter_aaaaaaaaaaaa" },
      kind: "memory",
    },
    undefined,
    { report: (s) => reported.push(s) }
  );
  expect(reported[0]).toEqual({
    limitSeconds: 125,
    plan: ["todo_items_ticked", "recorded"],
  });
  expect(reported.slice(1)).toEqual([
    {
      done: 1,
      key: "entry_000000000001",
      of: 2,
      step: "todo_items_ticked",
    },
    {
      done: 2,
      key: "entry_000000000002",
      of: 2,
      step: "todo_items_ticked",
    },
    { step: "recorded" },
  ]);
});

test("his goal by a matter's id is pinned to every step it holds; a step's id, another matter or an agent's token is refused", async () => {
  await correct({
    correction: {
      goal: "The boiler works.",
      kind: "matter-direction",
      matter: "matter_aaaaaaaaaaaa",
    },
    kind: "memory",
  });
  expect(readCorrections()).toMatchObject([
    { goal: "The boiler works.", steps: matter.steps.map((s) => s.ref) },
  ]);
  await expect(
    correct(
      {
        correction: { kind: "outdated", matter: "matter_aaaaaaaaaaaa" },
        kind: "memory",
      },
      "agt_000000000001"
    )
  ).rejects.toThrow("an agent's words are not his");
  await expect(
    correct({
      correction: { kind: "outdated", matter: "matter_bbbbbbbbbbbb" },
      kind: "memory",
    })
  ).rejects.toThrow("no matter");
  // PR 600's verdict: a step's id marked the whole matter holding it done.
  await expect(
    correct({
      correction: { kind: "outdated", matter: "obs_000000000001" },
      kind: "memory",
    })
  ).rejects.toThrow("give a matter's id");
  expect(readCorrections()).toHaveLength(1);
  expect(tick).not.toHaveBeenCalled();
});

test("with no words of his, the to-do items' ask says the words are Life's, and the correction has no note", async () => {
  await correct({
    correction: { kind: "outdated", matter: "matter_aaaaaaaaaaaa" },
    kind: "memory",
  });
  expect(tick).toHaveBeenCalledWith(
    ["entry_000000000001"],
    "Marked done (Life's words: he gave none).",
    expect.any(Function)
  );
  expect(readCorrections()[0]?.note).toBeUndefined();
});

test("his word on one step closes that step alone: a step a link ended still waits on it", async () => {
  const written = await endByHisWord(
    openStepsOf(matter as never, "obs_000000000002"),
    "Done on its card."
  );
  expect(tick).not.toHaveBeenCalled();
  expect(written).toHaveLength(1);
  expect(readCorrections()).toMatchObject([
    {
      kind: "outdated",
      note: "Done on its card.",
      observations: ["obs_000000000002"],
    },
  ]);
  // A step already retired is not open to his word: nothing to close, nothing written.
  expect(
    await endByHisWord(openStepsOf(matter as never, "obs_000000000003"), "x")
  ).toEqual([]);
});

// His important mark (20 Nov 2026): his word only, by a matter's id; the line written is the new state, for his toast.
test("his important mark by a matter's id is pinned to every step and answers with the new state; an agent, or no matter id, is refused", async () => {
  const mark = (important: boolean, id?: string) => ({
    correction: { important, kind: "matter-important", matter: id },
    kind: "memory" as const,
  });
  expect(await correct(mark(true, matter.id))).toMatchObject({
    done: [{ important: true, kind: "matter-important" }],
  });
  // Undo is the opposite word.
  expect(await correct(mark(false, matter.id))).toMatchObject({
    done: [{ important: false }],
  });
  expect(readCorrections()).toMatchObject([
    { important: true, steps: matter.steps.map((s) => s.ref) },
    { important: false, steps: matter.steps.map((s) => s.ref) },
  ]);
  await expect(
    correct(mark(true, matter.id), "agt_000000000001")
  ).rejects.toThrow("an agent's words are not his");
  // Pinned straight to steps, by an agent or by him: refused, never recorded.
  const bySteps = {
    correction: {
      important: true,
      kind: "matter-important",
      steps: ["obs_000000000001"],
    },
    kind: "memory" as const,
  };
  await expect(correct(bySteps, "agt_000000000001")).rejects.toThrow(
    "an agent's words are not his"
  );
  await expect(correct(bySteps)).rejects.toThrow("give a matter's id");
  expect(readCorrections()).toHaveLength(2);
});

// His icon (20 Nov 2026): his word only, by a matter's id; null gives it back to Life.
test("his icon by a matter's id is pinned to every step; null gives it back; an unknown key or an agent is refused before anything is written", async () => {
  const pick = (icon: string | null) => ({
    correction: { icon, kind: "matter-icon", matter: matter.id },
    kind: "memory" as const,
  });
  expect(await correct(pick("tools"))).toMatchObject({
    done: [{ icon: "tools", kind: "matter-icon" }],
  });
  expect(await correct(pick(null))).toMatchObject({ done: [{ icon: null }] });
  await expect(correct(pick("papers"))).rejects.toThrow();
  await expect(correct(pick("tools"), "agt_000000000001")).rejects.toThrow(
    "an agent's words are not his"
  );
  await expect(
    correct(
      {
        correction: {
          icon: "tools",
          kind: "matter-icon",
          steps: ["obs_000000000001"],
        },
        kind: "memory",
      },
      "agt_000000000001"
    )
  ).rejects.toThrow("an agent's words are not his");
  expect(readCorrections()).toMatchObject([
    { icon: "tools", steps: matter.steps.map((s) => s.ref) },
    { icon: null, steps: matter.steps.map((s) => s.ref) },
  ]);
  expect(readCorrections()).toHaveLength(2);
});

// #743's verdict: two matters read from one episode both show it as their step; a pin by steps alone went to the first.
test("a pin on the second of two matters holding the same step lands on it, and its reset too: icon, important mark and goal", async () => {
  const one = (id: string) => ({
    id,
    name: id,
    open: true,
    steps: [step("ep_000000000009", "episode")],
  });
  const list = [one("matter_aaaaaaaaaaaa"), one("matter_bbbbbbbbbbbb")];
  book.mockResolvedValue(list as never);
  const say = (said: object) =>
    correct({
      correction: { ...said, matter: "matter_bbbbbbbbbbbb" },
      kind: "memory",
    });
  const rows = () => {
    const find = matterFinderOf(list);
    const pins = readMatterPins();
    const icons = chosenIconsOf(find, pins.icons);
    const marked = importantIdsOf(find, pins.important);
    const goals = directionsOf(find, pins.directions);
    return list.map((v) => [
      icons.get(v.id) ?? null,
      marked.has(v.id),
      goals.get(v)?.goal?.text ?? null,
    ]);
  };
  await say({ icon: "paper", kind: "matter-icon" });
  await say({ important: true, kind: "matter-important" });
  await say({ goal: "The quote is signed.", kind: "matter-direction" });
  expect(rows()).toEqual([
    [null, false, null],
    ["paper", true, "The quote is signed."],
  ]);
  await say({ icon: null, kind: "matter-icon" });
  await say({ important: false, kind: "matter-important" });
  expect(rows()).toEqual([
    [null, false, null],
    [null, false, "The quote is signed."],
  ]);
});

// life#817: his next step may carry a context, a card's Markdown with live `life:` links.
test("his next step's context is kept with it; one without has none; a dead life: link is refused before anything is written", async () => {
  const next = (nextStep: object) =>
    correct({
      correction: { kind: "matter-direction", matter: matter.id, nextStep },
      kind: "memory",
    });
  const contextNow = () =>
    directionsOf(
      matterFinderOf([matter] as never),
      readMatterPins().directions
    ).get(matter as never)?.nextStep?.context;
  await next({
    context: "He said so [here](life:matter_aaaaaaaaaaaa).",
    kind: "do",
    text: "Call the plumber",
  });
  expect(contextNow()).toBe("He said so [here](life:matter_aaaaaaaaaaaa).");
  await next({ kind: "do", text: "Pay the plumber" });
  expect(contextNow()).toBeUndefined();
  await expect(
    next({
      context: "See [this](life:unit_0000000000ff).",
      kind: "do",
      text: "Call again",
    })
  ).rejects.toThrow("the link life:unit_0000000000ff opens nothing");
  // The cap is checked before any link is opened.
  await expect(
    next({
      context: `[this](life:unit_0000000000ff) ${"x".repeat(20_000)}`,
      kind: "do",
      text: "Call again",
    })
  ).rejects.toThrow("20000");
  expect(readCorrections()).toHaveLength(2);
});
