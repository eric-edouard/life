import { expect, test } from "bun:test";
import { action } from "./memory/fixtures";
import type { Action } from "./schema";
import {
  escalation,
  type Face,
  nudgeWhy,
  planOf,
  refusal,
  standing,
  steerOf,
  steersOf,
  type Task,
  tasksOf,
  wantOf,
} from "./tasks";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const MIN = 60_000;
const at = (min: number) => new Date(T0 + min * MIN).toISOString();
const ASK = "act_00000000000a";

const asked = action({
  after: { confidence: "high" },
  at: at(0),
  id: ASK,
  kind: "ask",
  madeBy: "watch",
  target: "atlas",
});
const own = (
  kind: Action["kind"],
  min: number,
  after: Action["after"],
  of = ASK
) =>
  action({
    after,
    at: at(min),
    id: `act_${String(min).padStart(12, "0")}`,
    instruction: undefined,
    kind,
    madeBy: kind === "update" ? "connector" : "watch",
    target: of,
  });
/** A task from its lines, all delivered unless `undelivered` counts the last ones that are not. */
const task = (lines: Action[], undelivered = 0): Task => {
  const all = [asked, ...lines].map((a) => JSON.stringify(a));
  const [t] = tasksOf(all, all.length - undelivered);
  if (!t) {
    throw new Error("no task");
  }
  return t;
};

test("the ledger as tasks: each ask gets its own lines in order, with what was delivered; other actions are left out", () => {
  const lines = [
    asked,
    action({}),
    own("update", 5, { note: "on it", state: "working" }),
    own("nudge", 6, { why: "x" }, "act_00000000000f"),
    own("nudge", 40, { why: "y" }),
  ].map((a) => JSON.stringify(a));
  const [t, ...rest] = tasksOf(lines, 3);
  expect(rest).toEqual([]);
  expect(t?.lines.map((l) => [l.a.kind, l.delivered])).toEqual([
    ["update", true],
    ["nudge", false],
  ]);
});

test("the write rules: claim once, required fields per state, deadlines ahead (24 h at most when working), nothing after done or dropped", () => {
  const now = T0 + MIN;
  const open = task([]);
  const deadline = at(120);
  const ok = { deadline, note: "on it", state: "working", task: ASK } as const;
  const claim = { ...ok, claim: true };
  expect(refusal(open, claim, now)).toBeNull();
  // The first update must be the claim, so two runs never both take the task.
  expect(refusal(open, ok, now)).toBe(
    "the first update claims the task: claim: true"
  );
  expect(refusal(undefined, ok, now)).toBe(`no task ${ASK}`);
  expect(refusal(open, { ...claim, note: undefined }, now)).toBe(
    "working needs note"
  );
  expect(refusal(open, { ...claim, deadline: at(0) }, now)).toBe(
    "the deadline is past"
  );
  expect(refusal(open, { ...claim, deadline: at(25 * 60) }, now)).toBe(
    "a working deadline is at most 24 h ahead"
  );
  expect(refusal(open, { claim: true, state: "done", task: ASK }, now)).toBe(
    "done needs outcome"
  );
  expect(
    refusal(
      open,
      {
        claim: true,
        question: "which flat?",
        state: "waiting-eric",
        task: ASK,
      },
      now
    )
  ).toBeNull();
  const claimed = task([
    own("update", 1, { deadline, note: "a", state: "working" }),
  ]);
  expect(refusal(claimed, claim, now)).toBe(
    "already claimed: the task is working"
  );
  expect(refusal(claimed, ok, now)).toBeNull();
  const done = task([own("update", 1, { outcome: "sent", state: "done" })]);
  expect(
    refusal(done, { reason: "no", state: "dropped", task: ASK }, now)
  ).toBe("the task is done: no update after that");
});

test("an open task is due 30 min after it was recorded, a claimed one at its own deadline", () => {
  expect(standing(task([])).deadline).toBe(at(30));
  expect(nudgeWhy(task([]), T0 + 29 * MIN)).toBeNull();
  expect(nudgeWhy(task([]), T0 + 30 * MIN)).toBe(
    "not claimed 30 min after the ask"
  );
  const working = task([
    own("update", 5, { deadline: at(60), note: "a", state: "working" }),
  ]);
  expect(nudgeWhy(working, T0 + 30 * MIN)).toBeNull();
  expect(nudgeWhy(working, T0 + 61 * MIN)).toBe("working past its deadline");
});

test("nudges are 30 min apart, only after the last one was delivered, and stop after 3 delivered ones go unanswered", () => {
  const one = [own("nudge", 15, { why: "x" })];
  expect(nudgeWhy(task(one), T0 + 44 * MIN)).toBeNull();
  expect(nudgeWhy(task(one), T0 + 45 * MIN)).not.toBeNull();
  expect(nudgeWhy(task(one, 1), T0 + 90 * MIN)).toBeNull();
  const three = [15, 45, 75].map((m) => own("nudge", m, { why: "x" }));
  expect(standing(task(three)).unanswered).toBe(3);
  expect(nudgeWhy(task(three), T0 + 200 * MIN)).toBeNull();
  // An undelivered nudge does not count.
  expect(standing(task(three, 1)).unanswered).toBe(2);
  // An update answers them.
  const answered = task([
    ...three,
    own("update", 80, { deadline: at(90), note: "a", state: "working" }),
  ]);
  expect(standing(answered).unanswered).toBe(0);
});

test("he is asked to look when Atlas is stuck, waits on him over an hour, a task is a week old, or Atlas isn't subscribed", () => {
  const now = T0 + 100 * MIN;
  expect(escalation(task([]), now, true)).toBeNull();
  expect(escalation(task([]), now, false)).toBe("Atlas isn't receiving asks");
  const three = [15, 45, 75].map((m) => own("nudge", m, { why: "x" }));
  expect(escalation(task(three), now, true)).toBe("Atlas stuck");
  const waiting = task([
    own("update", 30, {
      deadline: at(600),
      question: "which flat?",
      state: "waiting-eric",
    }),
  ]);
  expect(escalation(waiting, T0 + 89 * MIN, true)).toBeNull();
  expect(escalation(waiting, T0 + 91 * MIN, true)).toBe(
    "Atlas needs you: which flat?"
  );
  expect(escalation(task([]), T0 + 8 * 24 * 60 * MIN, true)).toBe(
    "stuck for 7 days"
  );
  const done = task([own("update", 30, { outcome: "sent", state: "done" })]);
  expect(escalation(done, now, false)).toBeNull();
});

const look = (over: Partial<Face> = {}): Face => ({
  completed: false,
  due: null,
  notes: "",
  section: "",
  steps: {},
  title: "Atlas: x",
  ...over,
});

test("the mirror writes only what Life wants changed: notes, section, due when he is needed, Life's steps added then ticked, close when done", () => {
  const steps = [
    { done: true, title: "Find three flats" },
    { done: false, title: "Book visits" },
  ];
  const working = task([
    own("update", 5, {
      deadline: at(60),
      note: "searching",
      state: "working",
      steps,
    }),
  ]);
  const want = wantOf(working, null, T0, undefined);
  expect(want.notes.split("\n")[0]).toBe(ASK);
  expect(want.notes).toContain("searching");
  expect(want.section).toBe("Working");
  const wrote = { ...want, section: "Open", steps: {} };
  const first = planOf(want, wrote, look(), {});
  expect(first.flags).toEqual(["--private", "--section=Working"]);
  expect(first.add).toEqual(["Find three flats", "Book visits"]);
  expect(first.tick).toEqual([]);
  // Next pass: the subtasks exist, so the done one is ticked, once.
  const seen = look({
    steps: { "Book visits": false, "Find three flats": false },
  });
  const second = planOf(want, first.wrote, seen, {
    "Book visits": 8,
    "Find three flats": 7,
  });
  expect(second.flags).toEqual([]);
  expect(second.tick).toEqual([7]);
  expect(planOf(want, second.wrote, second.seen, {}).tick).toEqual([]);
  // He is needed: Needs you with a due of now, kept until the cause ends, then cleared.
  const needed = wantOf(working, "Atlas stuck", T0, second.wrote);
  const alert = planOf(needed, second.wrote, second.seen, {});
  expect(alert.flags).toContain(`--due=${needed.due}`);
  expect(alert.flags).toContain("--section=Needs you");
  expect(wantOf(working, "Atlas stuck", T0 + 9 * MIN, alert.wrote).due).toBe(
    needed.due
  );
  expect(planOf(want, alert.wrote, alert.seen, {}).flags).toContain(
    "--due=clear"
  );
  const done = task([own("update", 5, { outcome: "booked", state: "done" })]);
  expect(
    planOf(wantOf(done, null, T0), second.wrote, second.seen, {}).finish
  ).toBe("done");
});

test("his changes are steers, Life's own writes are not, and Life never writes over them", () => {
  const working = task([
    own("update", 5, {
      deadline: at(60),
      note: "searching",
      state: "working",
      steps: [{ done: false, title: "Book visits" }],
    }),
  ]);
  const want = wantOf(working, null, T0);
  const p = planOf(
    want,
    { ...want, notes: "old", steps: {} },
    look({ notes: "old" }),
    {}
  );
  // The board after Life's write shows what Life expected: no steer.
  const after = { ...p.seen };
  expect(steerOf(p.seen, after).changes).toEqual([]);
  const his = look({
    ...after,
    completed: true,
    notes: `${after.notes}\nask the agency first`,
    steps: { ...after.steps, "Call the agency": false },
  });
  const steer = steerOf(p.seen, his);
  expect(steer.changes).toEqual([
    "ticked",
    "notes: ask the agency first",
    "added step: Call the agency",
  ]);
  expect(steer.note).toBe("ask the agency first");
  // Nothing Life wants changed: his tick, note and step stay.
  const next = planOf(want, p.wrote, his, {});
  expect([next.flags, next.add, next.tick, next.finish]).toEqual([
    [],
    [],
    [],
    null,
  ]);
  // His note shows as his until Atlas's next update.
  const steered = task([
    own("update", 5, { deadline: at(60), note: "searching", state: "working" }),
    own("steer", 7, { changes: steer.changes, note: steer.note }),
  ]);
  expect(wantOf(steered, null, T0).notes).toEndWith(
    "You: ask the agency first"
  );
  // His tick is not undone, until Life asks him to look.
  expect(
    planOf(wantOf(steered, "Atlas stuck", T0), p.wrote, his, {}).finish
  ).toBe("undone");
});

test("a steer is recorded for his changes and for an item he deleted, none for an unchanged item or a lost snapshot", () => {
  const seen = look({ notes: "x" });
  const shot = { id: 1, seen, wrote: seen };
  const item = (face: Face, id = 1) => ({ face, id, subIds: {} });
  const steers = (items: [string, ReturnType<typeof item>][]) =>
    steersOf({ [ASK]: shot }, new Map(items)).map((l) => l.after.changes);
  expect(steers([[ASK, item(seen)]])).toEqual([]);
  expect(steers([[ASK, item({ ...seen, completed: true })]])).toEqual([
    ["ticked"],
  ]);
  expect(steers([])).toEqual([["deleted"]]);
  // Another item under the same task (his snapshot was of an older one): a baseline, no steer.
  expect(steers([[ASK, item({ ...seen, completed: true }, 2)]])).toEqual([]);
  expect(steersOf({}, new Map([[ASK, item(seen)]]))).toEqual([]);
});
