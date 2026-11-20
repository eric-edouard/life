import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import type { InboxCheck } from "../memory/checks";
import { DECISIONS, decisionsNow, requestDecision } from "../memory/decisions";
import { CORRECTIONS, readCorrections } from "../memory/memory-files";
import { answerWithResult } from "./answer-result";

// His answer to a decision's `ends` option, with its proof (`answerWithResult`). Made-up matters and steps throughout.

let listed: ReturnType<typeof spyOn>;
beforeEach(async () => {
  rmSync(DECISIONS, { force: true });
  rmSync(CORRECTIONS, { force: true });
  listed = spyOn(
    await import("../memory/checks"),
    "checksNow"
  ).mockImplementation(async () =>
    decisionsNow()
      .filter((d) => d.state === "open")
      .map(
        (d) =>
          ({
            about: [],
            deadline: d.deadline,
            group: "decision",
            matter: null,
            pushId: "",
            ref: d.id,
          }) as unknown as InboxCheck
      )
  );
});
afterEach(() => listed.mockRestore());
afterAll(() => {
  rmSync(DECISIONS, { force: true });
  rmSync(CORRECTIONS, { force: true });
});

/** Runs a call and keeps every step it reports. */
const call = (ref: string, options: string[]) => {
  const steps: Record<string, unknown>[] = [];
  const result = answerWithResult(
    ref,
    { options },
    { report: (s) => steps.push(s) }
  );
  return { result, steps };
};

// 20 Nov 2026: "Done" on an agent's card ended nothing in Life. His pick of an `ends` option closes the matter by his
// word: its to-do items ticked, its observations outdated, with Life's words naming the card.
test("an `ends` option: the plan counts the ticks, the matter closes by his word, the asker hears it ended", async () => {
  const matter = {
    id: "matter_aaaaaaaaaaaa",
    open: true,
    steps: [
      { kind: "to_do", ref: "obs_000000000001" },
      { kind: "todo_item", ref: "entry_000000000001" },
    ],
  };
  const book = spyOn(
    await import("../memory/matters"),
    "readMatterBook"
  ).mockResolvedValue([matter] as never);
  const tick = spyOn(
    await import("./change-todo-item"),
    "tickTodoItems"
  ).mockImplementation((keys, _said, onTicked) => {
    onTicked?.(1, keys.length, keys[0] ?? "");
    return Promise.resolve([]);
  });
  try {
    const { id } = await requestDecision("planner", {
      context: "A made-up reason to ask.",
      deadline: new Date(Date.now() + 2 * DAY).toISOString(),
      onSilence: null,
      options: [
        { ends: "matter", id: "done", label: "Done" },
        { id: "later", label: "Not yet" },
      ],
      question: "Is the boiler mended?",
      subject: "matter_aaaaaaaaaaaa",
      title: "Mend the boiler",
    });
    const { result, steps } = call(id, ["done"]);
    const r = await result;
    expect(steps.map((s) => s.plan ?? s.step)).toEqual([
      ["recorded", "todo_items_ticked", "ended"],
      "recorded",
      "todo_items_ticked",
      "ended",
    ]);
    // One tick's minute, then the reads and the write.
    expect(steps[0]).toMatchObject({ limitSeconds: 65 });
    const note = `"Done" on "Mend the boiler" (${id})`;
    expect(tick).toHaveBeenCalledWith(
      ["entry_000000000001"],
      note,
      expect.any(Function)
    );
    expect(readCorrections()).toMatchObject([
      { kind: "outdated", note, observations: ["obs_000000000001"] },
    ]);
    expect(r).toMatchObject({
      changed: { decision: id, ended: {}, state: "answered" },
      done: [{ kind: "answered" }, { kind: "ended" }],
      send: null,
    });
    expect(r.changed).not.toHaveProperty("ended.error");
  } finally {
    book.mockRestore();
    tick.mockRestore();
  }
});

// Verdict on PR 699: the card's matter is the one closed. A matter's id stores its newest open step, never a unit other
// matters share; the answer finds it among open matters only, never a smaller closed one holding the same step.
test("an `ends` card on a matter's id closes that matter only: not one sharing its unit, not a closed one holding its step", async () => {
  const todo = (ref: string) => ({ kind: "to_do", ref });
  const shared = { kind: "episode", ref: "unit_000000000001" };
  const book = spyOn(
    await import("../memory/matters"),
    "readMatterBook"
  ).mockResolvedValue([
    {
      id: "matter_aaaaaaaaaaaa",
      open: true,
      steps: [todo("obs_00000000000a"), shared],
    },
    {
      id: "matter_bbbbbbbbbbbb",
      open: true,
      steps: [shared, todo("obs_00000000000b")],
    },
    {
      id: "matter_cccccccccccc",
      open: false,
      steps: [todo("obs_00000000000a")],
    },
  ] as never);
  try {
    const { id } = await requestDecision("planner", {
      context: "A made-up reason to ask.",
      deadline: new Date(Date.now() + 2 * DAY).toISOString(),
      onSilence: null,
      options: [
        { ends: "matter", id: "done", label: "Done" },
        { id: "later", label: "Not yet" },
      ],
      question: "Is it done?",
      subject: "matter_aaaaaaaaaaaa",
      title: "Mend the boiler",
    });
    expect(decisionsNow().find((d) => d.id === id)?.subject).toBe(
      "obs_00000000000a"
    );
    await call(id, ["done"]).result;
    expect(readCorrections()).toMatchObject([
      { kind: "outdated", observations: ["obs_00000000000a"] },
    ]);
  } finally {
    book.mockRestore();
  }
});

test("a step card whose step no open matter holds any more, and that never ended, says it closed nothing", async () => {
  const book = spyOn(await import("../memory/matters"), "readMatterBook")
    .mockResolvedValueOnce([
      {
        id: "matter_aaaaaaaaaaaa",
        open: true,
        steps: [{ kind: "to_do", ref: "obs_00000000000a" }],
      },
    ] as never)
    .mockResolvedValue([] as never);
  try {
    const { id } = await requestDecision("planner", {
      context: "A made-up reason to ask.",
      deadline: new Date(Date.now() + 2 * DAY).toISOString(),
      onSilence: null,
      options: [
        { ends: "step", id: "done", label: "Done" },
        { id: "later", label: "Not yet" },
      ],
      question: "Is it done?",
      subject: "obs_00000000000a",
      title: "Mend the boiler",
    });
    const r = await call(id, ["done"]).result;
    expect(r.changed).toMatchObject({
      ended: { error: expect.stringContaining("nothing was closed") },
    });
    expect(readCorrections()).toEqual([]);
  } finally {
    book.mockRestore();
  }
});
