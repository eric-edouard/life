import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planOf } from "../actions/board";
import type { Item } from "../actions/contract";
import { MIN } from "../core/clock";
import { appendJsonl, linesOf } from "../core/files";
import { recentEvents } from "../core/log";
import { AGENT_WORD } from "../core/names";
import { ROOT } from "../core/paths";
import { ACTIONS, type Task, tasksOf } from "../memory/ledger";
import { action } from "../memory/record-fixtures";
import { standing, type Update } from "../memory/tasks";
import { Action } from "../records/ledger-entry";
import {
  alerts,
  chase,
  escalation,
  protocol,
  receipts,
  refusal,
  reply,
  sealed,
  timings,
  unanswered,
  wantOf,
  written,
} from "./agent";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * MIN).toISOString();
const ASK = "act_00000000000a";

const asked = action({
  after: { confidence: "high" },
  at: at(0),
  id: ASK,
  kind: "ask",
  madeBy: "watch",
  target: AGENT_WORD,
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
/** A task from its lines. */
const task = (lines: Action[]): Task => {
  const [t] = tasksOf([asked, ...lines].map((a) => JSON.stringify(a)));
  if (!t) {
    throw new Error("no task");
  }
  return t;
};

test("the ledger as tasks: each ask gets its own lines in order, old nudges and steers too; other actions are left out", () => {
  const lines = [
    asked,
    action({}),
    own("update", 5, { note: "on it", state: "working" }),
    own("nudge", 6, { why: "x" }, "act_00000000000f"),
    own("nudge", 40, { why: "y" }),
    own("steer", 41, { changes: {}, note: "" }),
  ].map((a) => JSON.stringify(a));
  const [t, ...rest] = tasksOf(lines);
  expect(rest).toEqual([]);
  expect(t?.lines.map((l) => l.kind)).toEqual(["update", "nudge", "steer"]);
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
  // A duplicate ask is claimed and dropped in one update.
  expect(
    refusal(
      open,
      { claim: true, reason: "same as t1", state: "dropped", task: ASK },
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
  const later = task([
    own("update", 5, { deadline: at(60), note: "a", state: "working" }),
    own("update", 6, {
      deadline: "2026-10-19T12:30:00+01:00",
      note: "b",
      state: "working",
    }),
    own("update", 7, { deadline: at(60), note: "c", state: "working" }),
  ]);
  expect(standing(later).deadline).toBe(at(60));
});

test("he is emailed when a task is unclaimed after 30 min, silent past its deadline, waits on him over an hour, is a week old, or Orbit isn't subscribed; once per cause and update", () => {
  const now = T0 + 20 * MIN;
  expect(escalation(task([]), now)).toBeNull();
  expect(escalation(task([]), T0 + 30 * MIN)).toBe(
    "not claimed 30 min after the ask"
  );
  const working = task([
    own("update", 5, { deadline: at(60), note: "a", state: "working" }),
  ]);
  expect(escalation(working, T0 + 59 * MIN)).toBeNull();
  expect(escalation(working, T0 + 61 * MIN)).toBe("working past its deadline");
  const waiting = task([
    own("update", 30, {
      deadline: at(600),
      question: "which flat?",
      state: "waiting-eric",
    }),
  ]);
  expect(escalation(waiting, T0 + 89 * MIN)).toBeNull();
  expect(escalation(waiting, T0 + 91 * MIN)).toBe(
    "Orbit needs you: which flat?"
  );
  const week = 8 * 24 * 60;
  const extended = task([
    own("update", week - 5, {
      deadline: at(week + 60),
      note: "a",
      state: "working",
    }),
  ]);
  expect(escalation(extended, T0 + week * MIN)).toBe("stuck for 7 days");
  // Emailed once, however often Orbit extends it.
  const extendedAgain = task([
    ...extended.lines,
    own("update", week + 30, {
      deadline: at(week + 120),
      note: "b",
      state: "working",
    }),
  ]);
  expect(alerts([extendedAgain], T0 + (week + 31) * MIN, true)[0]?.key).toBe(
    alerts([extended], T0 + week * MIN, true)[0]?.key
  );
  const done = task([own("update", 30, { outcome: "sent", state: "done" })]);
  expect(escalation(done, now)).toBeNull();
  // A task Orbit made from his chat is chased too.
  const chat = action({
    ...asked,
    id: "act_00000000000b",
    madeBy: "connector",
  });
  const both = tasksOf([asked, chat].map((a) => JSON.stringify(a)));
  expect(
    alerts(both, T0 + 31 * MIN, true).map((x) => ("t" in x ? x.t.ask.id : ""))
  ).toEqual([ASK, "act_00000000000b"]);
  // The key changes with Orbit's last update: silent again after one is a new email; the same silence is not.
  const key = (t: Task, m: number) => alerts([t], T0 + m * MIN, true)[0]?.key;
  expect(key(working, 61)).toBe(key(working, 120));
  const again = task([
    own("update", 5, { deadline: at(60), note: "a", state: "working" }),
    own("update", 70, { deadline: at(90), note: "b", state: "working" }),
  ]);
  expect(key(again, 91)).not.toBe(key(working, 61));
  // A lapsed subscription is one email, whatever the number of open tasks.
  expect(alerts(both, T0 + 31 * MIN, false)).toEqual([
    {
      cause: "Orbit isn't receiving asks",
      key: "lapse/2026-10-19",
      open: 2,
    },
  ]);
});

test("chase sends one email a pass, listing every task that newly needs him; each cause is sent once", async () => {
  const env = { ...process.env };
  process.env.RESEND_PERSONAL_API_KEY = "test";
  const subjects: string[] = [];
  const post = spyOn(globalThis, "fetch").mockImplementation(((
    _url: string,
    init: RequestInit
  ) => {
    subjects.push(JSON.parse(String(init.body)).subject);
    return Promise.resolve(Response.json({ id: `email_${subjects.length}` }));
  }) as unknown as typeof fetch);
  const spoken = (id: string, min: number, quote: string) =>
    JSON.stringify(
      action({
        ...asked,
        at: at(min),
        id,
        instruction: { at: at(min), quote, ref: `job-9:${min}@${at(min)}` },
      })
    );
  const tasks = tasksOf([
    spoken("act_0000000c4a5e", 0, "hey Orbit, book the table"),
    spoken("act_0000000c4a5f", 0, "hey Orbit, call the bank"),
    spoken("act_0000000c4a60", 20, "hey Orbit, water the plant"),
  ]);
  const late = "(not claimed 30 min after the ask)";
  try {
    await chase(tasks, T0 + 31 * MIN, true);
    await chase(tasks, T0 + 32 * MIN, true);
    await chase(tasks, T0 + 51 * MIN, true);
    expect(subjects).toEqual([
      `Life · Orbit: book the table ${late}, call the bank ${late}`,
      `Life · Orbit: water the plant ${late}`,
    ]);
    // One `email.sent` line per key, so each cause is remembered on its own.
    const keys = (await recentEvents<{ key: string }>(1, "email.sent"))
      .map((e) => e.key)
      .filter((k) => k.includes("act_0000000c4a"));
    expect(keys).toHaveLength(3);
    // No live subscription: one email for all the open tasks, once a day.
    await chase(tasks, T0 + 52 * MIN, false);
    await chase(tasks, T0 + 53 * MIN, false);
    expect(subjects.slice(2)).toEqual(["Life · Orbit isn't receiving asks"]);
  } finally {
    post.mockRestore();
    process.env = env;
  }
});

const look = (over: Partial<Item> = {}): Item => ({
  completed: false,
  id: "1",
  notes: "",
  section: "",
  title: "Orbit: Book visits",
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

test("the board gets Life's fields: notes and section in line, a tick when done; his tick is his", () => {
  const want = wantOf(working());
  expect(want.notes.split("\n")[0]).toBe(ASK);
  expect(want.notes).toContain("searching");
  const blank = look({ notes: want.notes, section: "Open" });
  expect(planOf(want, blank)).toEqual({
    done: false,
    fields: { section: "Working" },
  });
  // Where the backend has no sections (Google Tasks), the notes alone carry the task's state.
  expect(planOf(want, blank, false)).toEqual({ done: false, fields: {} });
  const kept = look({ notes: want.notes, section: "Working" });
  expect(planOf(want, kept)).toEqual({ done: false, fields: {} });
  expect(planOf(want, { ...kept, completed: true }).done).toBe(false);
  const done = task([own("update", 5, { outcome: "booked", state: "done" })]);
  expect(planOf(wantOf(done), kept).done).toBe(true);
  // An old steer line changes nothing: no "You:" line.
  const steered = working([own("steer", 7, { changes: {}, note: "his" })]);
  expect(wantOf(steered)).toEqual(want);
});

const TEXT = "# Orbit: the playbook";
const { seal } = sealed(T0, TEXT);
const claiming = {
  claim: true,
  deadline: at(60),
  note: "on it",
  seal,
  state: "working",
} as const;
const write = (u: Update, lines: Action[] = [], now = T0) =>
  written(
    u,
    tasksOf([asked, ...lines].map((a) => JSON.stringify(a))),
    now,
    TEXT
  );

test("a write needs the seal of the current playbook: refused when stale or missing, with the text and the new seal", () => {
  expect(write({ ...claiming, task: ASK }).answer).toBe(`${ASK}: working`);
  // The previous window's seal still holds; older ones and a changed text do not.
  expect(
    write({ ...claiming, deadline: at(400), task: ASK }, [], T0 + 6 * 60 * MIN)
      .answer
  ).toBe(`${ASK}: working`);
  for (const [u, now] of [
    [{ ...claiming, task: ASK }, T0 + 13 * 60 * MIN],
    [{ ...claiming, seal: undefined, task: ASK }, T0],
  ] as const) {
    expect(() => write(u, [], now)).toThrow(sealed(now, TEXT).seal);
    expect(() => write(u, [], now)).toThrow(TEXT);
  }
  expect(() => written({ ...claiming, task: ASK }, [], T0, `${TEXT}!`)).toThrow(
    "Not the current seal"
  );
});

test("his words in a chat make a task, claimed at once, once per message and part; never without his words", () => {
  const chat = {
    ...claiming,
    at: at(-5),
    said: "book the dentist and the vet",
    title: "dentist",
  };
  const { answer, lines } = write(chat);
  const [made, claim] = lines;
  expect(made).toMatchObject({
    after: { confidence: "high", title: "dentist" },
    instruction: { at: at(-5), quote: chat.said, ref: `connector:${at(-5)}` },
    madeBy: "connector",
  });
  expect(claim).toMatchObject({ after: { claim: true }, target: made?.id });
  expect(answer).toBe(`${made?.id}: working`);
  // A retry finds it, whatever the offset of its time; another part of the same message is another task.
  const retry = { ...chat, at: "2026-10-19T16:55:00.000+07:00" };
  expect(write(retry, lines)).toEqual({
    answer: `${made?.id}: already a task`,
    lines: [],
  });
  expect(write({ ...chat, title: "vet" }, lines).lines).toHaveLength(2);
  expect(() => write({ ...claiming, at: at(-5) })).toThrow("name one of task");
  expect(() => write({ ...chat, at: undefined })).toThrow("said needs at");
  expect(() => write({ ...chat, at: at(5) })).toThrow("said needs at");
  expect(() => write({ ...claiming, task: ASK, title: "x" })).toThrow(
    "name one of"
  );
});

test("a split inherits its parent's words, one level only, and never takes new ones", () => {
  const split = { ...claiming, parent: ASK, title: "Book visits" };
  const [child] = write(split).lines;
  expect(child?.instruction).toEqual(asked.instruction);
  expect(child?.after).toMatchObject({ parent: ASK, title: "Book visits" });
  const [t] = tasksOf([JSON.stringify(child)]);
  expect(t && wantOf(t).title).toBe("Orbit: Book visits");
  // A split's id comes from its parent: it never meets a sibling made from the same message, nor its parent.
  const chat = { ...claiming, at: at(-5), said: "dentist and vet" };
  const dentist = write({ ...chat, title: "dentist" }).lines;
  const of = { ...claiming, parent: dentist[0]?.id };
  const vet = write({ ...of, title: "vet" }, dentist).lines[0]?.id;
  expect(vet).not.toBe(write({ ...chat, title: "vet" }, dentist).lines[0]?.id);
  expect(write({ ...of, title: "Dentist" }, dentist).lines).toHaveLength(2);
  expect(() => write({ ...split, said: "new words" })).toThrow("name one of");
  expect(() => write({ ...split, title: undefined })).toThrow(
    "a split needs title"
  );
  const grand = { ...claiming, parent: child?.id, title: "Call" };
  expect(() => write(grand, write(split).lines)).toThrow("is a part");
  const done = own("update", 1, { outcome: "split", state: "done" });
  expect(() => write(split, [done])).toThrow(`${ASK} is done`);
});

test("where an ask's time went: spoken, ended, arrived, recorded, delivered, claimed, closed; a split's parts are left out", async () => {
  // Two deliveries of the ask on two days, in their own log: the first is when Orbit got it.
  const dir = mkdtempSync(join(tmpdir(), "life-sent-"));
  const sent = (day: string, min: number) =>
    writeFileSync(
      join(dir, `${day}.jsonl`),
      `${JSON.stringify({ at: at(min), event: ASK, kind: "event.sent" })}\n`
    );
  sent("2026-10-19", 1);
  sent("2026-10-20", 30);
  const heard = {
    ...asked,
    timing: { arrived: at(-1), ended: at(-2) },
  } satisfies Action;
  const part = action({
    after: { confidence: "high", parent: ASK, title: "a part" },
    at: at(1),
    id: "act_00000000000b",
    kind: "ask",
    target: AGENT_WORD,
  });
  const lines = [
    heard,
    part,
    own("update", 5, { claim: true, state: "working" }),
    own("update", 9, { outcome: "sent", state: "done" }),
  ].map((a) => JSON.stringify(a));
  const [t, ...rest] = await timings(at(-60), at(60), tasksOf(lines), dir);
  expect(rest).toEqual([]);
  const moments = Object.fromEntries(t?.moments ?? []);
  expect(moments).toMatchObject({
    arrived: at(-1),
    claimed: at(5),
    closed: at(9),
    ended: at(-2),
    recorded: at(0),
  });
  expect(moments.delivered).toBe(at(1));
  expect(t?.moments.map(([m]) => m)).toEqual([
    "spoke",
    "ended",
    "arrived",
    "recorded",
    "delivered",
    "claimed",
    "closed",
  ]);
});

test("a reply is a line of its task's history (or of no task, `chat`); the day's asks with none are counted, splits left out", () => {
  const answered = task([own("reply", 1, { text: "Booked." })]);
  expect(answered.lines.map((l) => l.kind)).toEqual(["reply"]);
  expect(standing(answered).state).toBe("open");
  const split = task([]);
  split.ask = { ...split.ask, after: { parent: ASK } };
  expect(unanswered(T0, [answered, task([]), split])).toBe(1);
  expect(unanswered(T0 + MIN, [task([])])).toBe(0);
  try {
    appendJsonl(ACTIONS, Action, [asked]);
    expect(reply({ task: ASK, text: "On it." }, T0 + MIN)).toBe(
      `${ASK}: reply logged`
    );
    reply({ text: "Hello." }, T0 + 2 * MIN);
    expect(() => reply({ task: "act_nope00000000", text: "x" })).toThrow(
      "no task"
    );
    const [t] = tasksOf();
    expect(t?.lines.map((l) => [l.kind, l.after.text])).toEqual([
      ["reply", "On it."],
    ]);
    expect(
      Action.parse(JSON.parse(linesOf(ACTIONS).at(-1) as string))
    ).toMatchObject({
      after: { text: "Hello." },
      kind: "reply",
      madeBy: "connector",
      target: "chat",
    });
  } finally {
    rmSync(ACTIONS, { force: true });
  }
});

test("the board's receipts leave out a task closed over a day ago: he may have unticked its item", () => {
  const closedAt = (min: number) =>
    task([own("update", min, { outcome: "done", state: "done" })]);
  const now = T0 + 25 * 60 * MIN;
  expect(receipts([closedAt(0), closedAt(120)], now)).toHaveLength(1);
  expect(receipts([task([])], now)[0]).toMatchObject({
    completed: false,
    id: ASK,
  });
});

test("the playbook's Reminders parts only while the plugin is on: on, the protocol reads as it always did", () => {
  const text = "A.<!-- reminders --> B.<!-- /reminders --> C.";
  expect(protocol(text, true)).toBe("A. B. C.");
  expect(protocol(text, false)).toBe("A. C.");
  const off = protocol(
    readFileSync(join(ROOT, "docs", "agent.md"), "utf8"),
    false
  );
  expect(off).not.toContain("open_reminders");
  expect(off).not.toContain("standing grant");
});
