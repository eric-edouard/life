import { expect, test } from "bun:test";
import { type Item, planOf, steerOf, wantOf } from "./board";
import { action } from "./memory/fixtures";
import type { Action } from "./schema";
import { escalation, refusal, standing, type Task, tasksOf } from "./tasks";

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
  expect(t?.lines.map((l) => [l.kind, l.delivered])).toEqual([
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
  expect(standing(task([]), T0 + 29 * MIN).nudge).toBeNull();
  expect(standing(task([]), T0 + 30 * MIN).nudge).toBe(
    "not claimed 30 min after the ask"
  );
  const working = task([
    own("update", 5, { deadline: at(60), note: "a", state: "working" }),
  ]);
  expect(standing(working, T0 + 30 * MIN).nudge).toBeNull();
  expect(standing(working, T0 + 61 * MIN).nudge).toBe(
    "working past its deadline"
  );
});

test("nudges are 30 min apart, only after the last one was delivered, and stop after 3 delivered ones go unanswered", () => {
  const one = [own("nudge", 15, { why: "x" })];
  expect(standing(task(one), T0 + 44 * MIN).nudge).toBeNull();
  expect(standing(task(one), T0 + 45 * MIN).nudge).not.toBeNull();
  expect(standing(task(one, 1), T0 + 90 * MIN).nudge).toBeNull();
  const three = [15, 45, 75].map((m) => own("nudge", m, { why: "x" }));
  expect(standing(task(three)).unanswered).toBe(3);
  expect(standing(task(three), T0 + 200 * MIN).nudge).toBeNull();
  // An undelivered nudge does not count.
  expect(standing(task(three, 1)).unanswered).toBe(2);
  // An update answers them.
  const answered = task([
    ...three,
    own("update", 80, { deadline: at(90), note: "a", state: "working" }),
  ]);
  expect(standing(answered).unanswered).toBe(0);
  // An extension is an update that moved the deadline later, whatever its offset.
  const later = task([
    own("update", 5, { deadline: at(60), note: "a", state: "working" }),
    own("update", 6, {
      deadline: "2026-10-19T12:30:00+01:00",
      note: "b",
      state: "working",
    }),
    own("update", 7, { deadline: at(60), note: "c", state: "working" }),
  ]);
  expect(standing(later).extensions).toBe(1);
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

const look = (over: Partial<Item> = {}): Item => ({
  completed: false,
  due: null,
  id: 1,
  notes: "",
  section: "",
  steps: {},
  subIds: {},
  title: "Atlas: x",
  ...over,
});

const working = (more: Action[] = []) =>
  task([
    own("update", 5, {
      deadline: at(60),
      note: "searching",
      state: "working",
      steps: [
        { done: true, title: "Find three flats" },
        { done: false, title: "Book visits" },
      ],
    }),
    ...more,
  ]);

test("the board gets Life's fields: notes, section, Atlas's steps added then ticked, Needs you with a due while he is needed, a tick when done", () => {
  const want = wantOf(working(), null);
  expect(want.notes.split("\n")[0]).toBe(ASK);
  expect(want.notes).toContain("searching");
  const blank = look({ notes: want.notes, section: "Open" });
  const first = planOf(want, blank, undefined, T0);
  expect(first.flags).toEqual([
    "--private",
    "--section=Working",
    '--subtask={"title":"Find three flats"}',
    '--subtask={"title":"Book visits"}',
  ]);
  // Next pass: the subtasks exist, so the done one is ticked; then nothing is left to write.
  const steps = { "Book visits": false, "Find three flats": false };
  const subIds = { "Book visits": 8, "Find three flats": 7 };
  const made = { ...first.look, steps, subIds };
  const second = planOf(want, made, first.look, T0);
  expect([second.flags, second.done]).toEqual([[], [7]]);
  // A step Life added and he removed stays removed.
  const removed = { ...made, steps: { "Find three flats": false } };
  expect(planOf(want, removed, second.look, T0).flags).toEqual([]);
  const ticked = second.look;
  expect(planOf(want, ticked, ticked, T0).done).toEqual([]);
  // He is needed: Needs you with a due of now, kept while the cause lasts, cleared when it ends.
  const needed = wantOf(working(), "Atlas stuck");
  const alert = planOf(needed, ticked, ticked, T0);
  expect(alert.flags).toContain(`--due=${alert.look.due}`);
  expect(alert.flags).toContain("--section=Needs you");
  const later = planOf(needed, alert.look, alert.look, T0 + 9 * MIN);
  expect(later.flags).toEqual([]);
  expect(planOf(want, alert.look, alert.look, T0).flags).toEqual([
    `--notes=${want.notes}`,
    "--due=clear",
    "--alarm=clear",
    "--private",
    "--section=Working",
  ]);
  const done = task([own("update", 5, { outcome: "booked", state: "done" })]);
  expect(planOf(wantOf(done, null), ticked, ticked, T0).done).toEqual([1]);
});

test("his changes are steers, Life's own writes are not, and Life never writes over his tick, title, due or subtasks", () => {
  const want = wantOf(working(), null);
  const p = planOf(want, look({ notes: "old" }), undefined, T0);
  const after = {
    ...p.look,
    steps: { "Book visits": false, "Find three flats": true },
  };
  expect(steerOf(after, after).changes).toEqual({});
  const steps = { ...after.steps, "Call the agency": false };
  const his = look({
    ...after,
    completed: true,
    due: "2026-10-20 09:00",
    notes: `${after.notes}\nask the agency first`,
    steps,
    title: "Atlas: flats",
  });
  const steer = steerOf(after, his);
  expect(steer.changes).toEqual({
    completed: true,
    due: "2026-10-20 09:00",
    notes: his.notes,
    steps,
    title: "Atlas: flats",
  });
  expect(steer.note).toBe("ask the agency first");
  // His note shows as his until Atlas's next update; nothing else of his is written over.
  const steered = working([own("steer", 7, steer)]);
  const next = planOf(wantOf(steered, null), his, his, T0);
  expect(wantOf(steered, null).notes).toEndWith("You: ask the agency first");
  expect(next.flags).toEqual([`--notes=${wantOf(steered, null).notes}`]);
  expect([next.done, next.reopen]).toEqual([[], false]);
  // His tick is not undone, until Life asks him to look.
  expect(planOf(wantOf(steered, "Atlas stuck"), his, his, T0).reopen).toBe(
    true
  );
});
