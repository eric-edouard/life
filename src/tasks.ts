import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { actionId, requested } from "./actions";
import { deliveredLines, parse } from "./events";
import { ACTIONS, appendJsonl, digest, linesOf } from "./memory/ledger";
import { clip } from "./memory/units";
import { Action, type Instruction, type TASK_LINES } from "./schema";
import { ROOT } from "./truth";

// Atlas's tasks: each ask (his "hey Atlas", or `bun life ask`) is a task in memory/actions.jsonl until Atlas closes it
// done or dropped. Its own lines: Atlas's updates (the connector's `task`), Life's nudges and his steers (src/board.ts).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** An unclaimed ask is nudged 30 min after it was recorded (Atlas picks events up 5 to 22 min late), nudges as far apart. */
const NUDGE_MS = 30 * MIN;

const iso = (ms: number) => new Date(ms).toISOString();

/** Atlas's playbook, read from its one source on every call: `tasks` returns it, `task` refuses a write without its seal. */
const playbook = () => readFileSync(join(ROOT, "docs", "atlas.md"), "utf8");
const WINDOW = 6 * HOUR;
/** The playbook's revision, on each of Atlas's updates: which text it wrote under. */
const revision = (text: string) => digest("sha256", text, 12);
/** The playbook and its seal: a hash of the text and its 6 h window, so a seal recalled from memory dies within 12 h. */
export const sealed = (now = Date.now(), text = playbook()) => ({
  playbook: text,
  seal: digest("sha256", `${revision(text)}@${Math.floor(now / WINDOW)}`, 16),
});

/**
 * One ask line: his words, where they are (`ref`: the wake turn, the session, the chat message) and `after`
 * (`confidence`; for speech `conversation` and `turns`; for a part of one message or a split, `title`).
 */
const askLine = (
  instruction: Instruction,
  after: Action["after"],
  madeBy: "connector" | "session" | "watch",
  why: string,
  now = Date.now()
) =>
  ({
    after,
    at: iso(now),
    id: actionId(instruction.ref, "ask", `${after.title ?? ""}`),
    // Clipped so its event stays far under the 256 KiB a webhook may carry; Atlas fetches the rest.
    instruction: { ...instruction, quote: clip(instruction.quote, 50_000) },
    kind: "ask",
    madeBy,
    result: "ok",
    schemaVersion: 1,
    target: "atlas",
    why,
  }) satisfies Action;

/** Records one ask for Atlas (the watcher delivers it). The same ref and title ask once. */
export function ask(...a: Parameters<typeof askLine>) {
  const action = askLine(...a);
  const old = tasksOf().find((t) => t.ask.id === action.id)?.ask;
  if (!old) {
    appendJsonl(ACTIONS, Action, [action]);
  }
  return old ?? action;
}

const lineOf = (
  task: string,
  kind: (typeof TASK_LINES)[number],
  after: Action["after"],
  now: number
): Action => ({
  after,
  at: iso(now),
  id: actionId(`${task}@${iso(now)}`, kind, ""),
  kind,
  madeBy: kind === "update" ? "connector" : "watch",
  result: "ok",
  schemaVersion: 1,
  target: task,
  why: { nudge: "late", steer: "he changed the board", update: "Atlas" }[kind],
});

/** Appends one of a task's own lines (synchronous: two runs cannot both claim a task). */
export const taskLine = (...a: Parameters<typeof lineOf>) =>
  appendJsonl(ACTIONS, Action, [lineOf(...a)]);

export interface Task {
  ask: Action & { instruction: Instruction };
  /** Its own lines in ledger order; `delivered`: the watcher has sent it (or passed it over). */
  lines: (Action & { delivered: boolean })[];
}

/** The ledger as tasks: each ask with its own lines. */
export function tasksOf(lines = linesOf(ACTIONS), delivered = 0) {
  const tasks = new Map<string, Task>();
  for (const [i, a] of lines.map(parse).entries()) {
    if (a?.kind === "ask" && a.instruction) {
      tasks.set(a.id, { ask: { ...a, instruction: a.instruction }, lines: [] });
    } else if (a) {
      tasks.get(a.target)?.lines.push({ ...a, delivered: i < delivered });
    }
  }
  return [...tasks.values()];
}

export const closed = (s: State) => s === "done" || s === "dropped";

/**
 * Where a task stands: its last update (`end`), deadline (an open one's: 30 min after it was recorded), steps; `nudge`:
 * why it is nudged now (the one rule: past its deadline, 30 min after the last nudge was delivered, until 3 delivered
 * ones go unanswered).
 */
export function standing(t: Task, now = Date.now()) {
  const updates = t.lines.filter((l) => l.kind === "update");
  const end: Partial<Update> = updates.at(-1)?.after ?? {};
  const since = updates.at(-1)?.at ?? t.ask.at;
  const state = end.state ?? ("open" as State);
  const deadline = updates.length
    ? end.deadline
    : iso(Date.parse(since) + NUDGE_MS);
  const nudges = t.lines.filter((l) => l.kind === "nudge");
  const prev = nudges.at(-1);
  const unanswered = nudges.filter((n) => n.delivered && n.at > since).length;
  const ends = updates.map((u) => Date.parse(`${u.after.deadline}`));
  const late =
    !closed(state) &&
    Date.parse(deadline ?? "") <= now &&
    unanswered < 3 &&
    (!prev || (prev.delivered && now - Date.parse(prev.at) >= NUDGE_MS));
  const why =
    state === "open"
      ? "not claimed 30 min after the ask"
      : `${state} past its deadline`;
  return {
    deadline,
    end,
    // Updates that moved the deadline later.
    extensions: ends.filter((d, i) => d > (ends[i - 1] ?? d)).length,
    nudge: late ? why : null,
    nudges: nudges.length,
    since,
    state,
    /** His steers since Atlas's last update. */
    steers: t.lines.filter((l) => l.kind === "steer" && l.at > since),
    steps: (updates.findLast((u) => u.after.steps)?.after.steps ??
      []) as Step[],
    unanswered,
    /** Atlas's last word: the outcome or reason once closed. */
    word: end.outcome ?? end.reason ?? end.question ?? end.note,
  };
}

/** Why he must look at a task now (its item goes to "Needs you" with a due), or null. */
export function escalation(t: Task, now: number, live: boolean) {
  const { end, since, state, unanswered } = standing(t, now);
  if (closed(state)) {
    return null;
  }
  if (!live) {
    return "Atlas isn't receiving asks";
  }
  if (unanswered >= 3) {
    return "Atlas stuck";
  }
  if (state === "waiting-eric" && now - Date.parse(since) > HOUR) {
    return `Atlas needs you: ${end.question}`;
  }
  return now - Date.parse(t.ask.at) > 7 * DAY ? "stuck for 7 days" : null;
}

const Text = z.string().min(1).max(2000);
const Step = z.object({
  done: z.boolean(),
  title: z.string().trim().min(1).max(200),
});
type Step = z.infer<typeof Step>;
const Instant = z.iso.datetime({ offset: true });
/** One update from Atlas (the connector's `task`): on `task`, or a new one from his words (`said`) or a split (`parent`). */
export const Update = z.object({
  at: Instant.optional().describe("said: when he sent it"),
  claim: z.boolean().optional().describe("true on the first update only"),
  deadline: Instant.optional(),
  note: Text.optional(),
  on: z.string().max(200).optional().describe("What or whom it waits for"),
  outcome: Text.optional(),
  parent: z.string().optional().describe("Splits this task: with `title`"),
  question: Text.optional().describe("waiting-eric: what you asked him"),
  reason: Text.optional(),
  said: Text.optional().describe("A new task: his words, verbatim"),
  seal: z.string().optional().describe("The `seal` from `tasks`"),
  state: z.enum(["working", "waiting-eric", "done", "dropped"]),
  steps: z.array(Step).max(30).optional().describe("The full list every time"),
  task: z.string().optional().describe("The task's id"),
  title: z.string().trim().min(1).max(200).optional().describe("The part"),
});
export type Update = z.infer<typeof Update>;
type State = Update["state"] | "open";

const REQUIRED = {
  done: ["outcome"],
  dropped: ["reason"],
  "waiting-eric": ["question"],
  working: ["deadline", "note"],
} as const;

/** Why Life refuses an update, or null: the write rules. */
export function refusal(t: Task | undefined, u: Update, now: number) {
  if (!t) {
    return `no task ${u.task}`;
  }
  const { state } = standing(t, now);
  const missing = REQUIRED[u.state].filter((k) => !u[k]);
  const deadline = Date.parse(u.deadline ?? "");
  if (closed(state)) {
    return `the task is ${state}: no update after that`;
  }
  if (Boolean(u.claim) !== (state === "open")) {
    return state === "open"
      ? "the first update claims the task: claim: true"
      : `already claimed: the task is ${state}`;
  }
  if (missing.length > 0) {
    return `${u.state} needs ${missing.join(" and ")}`;
  }
  if (deadline <= now) {
    return "the deadline is past";
  }
  return u.state === "working" && deadline > now + DAY
    ? "a working deadline is at most 24 h ahead"
    : null;
}

/** The task `u` makes: from his words in a chat, or a split of an open task (its words, never new ones); throws why not. */
function made(
  u: Update,
  tasks: Task[],
  now: number
): Parameters<typeof askLine> {
  const p = tasks.find((t) => t.ask.id === u.parent);
  if (p && u.title && !p.ask.after.parent && !closed(standing(p, now).state)) {
    const after = { ...p.ask.after, parent: p.ask.id, title: u.title };
    return [p.ask.instruction, after, "connector", "split by Atlas", now];
  }
  if (u.parent) {
    throw new Error("a split needs title and an open task that is no split");
  }
  const sent = Date.parse(u.at ?? "");
  if (!(sent <= now + MIN && sent > now - 7 * DAY)) {
    throw new Error("said needs at: when he sent it, in the last 7 days");
  }
  // His message's instant, normalized: the same message makes the same id whatever the offset it was given in.
  const chat = requested("connector", `${u.said}`, iso(sent));
  const after = { confidence: "high", title: u.title };
  return [chat, after, "connector", "asked Atlas in a chat", now];
}

/**
 * The ledger lines Atlas's update appends (a task it makes first, claimed by this update, so a retry finds it) and Life's answer;
 * throws why not, with the playbook and its seal when the seal is not current.
 */
export function written(
  u: Update,
  tasks: Task[],
  now: number,
  text = playbook()
) {
  if (![now, now - WINDOW].some((w) => sealed(w, text).seal === u.seal)) {
    const { seal } = sealed(now, text);
    throw new Error(
      `Not the current seal: follow this playbook, then retry with seal "${seal}".\n\n${text}`
    );
  }
  const { at, parent, said, seal, task, title, ...after } = u;
  if (
    [task, said, parent].filter(Boolean).length !== 1 ||
    (task && (at || title))
  ) {
    throw new Error(
      "name one of task (no at, no title), said (a new task) or parent (a split)"
    );
  }
  const fresh = task ? undefined : askLine(...made(u, tasks, now));
  if (fresh && tasks.some((x) => x.ask.id === fresh.id)) {
    return { answer: `${fresh.id}: already a task`, lines: [] };
  }
  const id = fresh?.id ?? `${task}`;
  const t = fresh
    ? { ask: fresh, lines: [] }
    : tasks.find((x) => x.ask.id === id);
  const why = refusal(t, u, now);
  if (why) {
    throw new Error(why);
  }
  if (u.state === "waiting-eric") {
    after.deadline ??= iso(now + DAY);
  }
  const line = lineOf(
    id,
    "update",
    { ...after, playbook: revision(text) },
    now
  );
  return { answer: `${id}: ${u.state}`, lines: fresh ? [fresh, line] : [line] };
}

/** Records Atlas's update when the rules allow it (synchronous, from reading the ledger to the lines); throws why not. */
export function update(u: Update, now = Date.now()) {
  const { answer, lines } = written(u, tasksOf(), now);
  appendJsonl(ACTIONS, Action, lines);
  return answer;
}

/**
 * Every open task, and the ones closed in the last day: the connector's `tasks` (with his steers since Atlas's last
 * update) and the nightly's rows.
 */
export function taskList(now = Date.now()) {
  return tasksOf().flatMap((t) => {
    const s = standing(t, now);
    const h = Math.floor((now - Date.parse(t.ask.at)) / HOUR);
    if (closed(s.state) && now - Date.parse(s.since) > DAY) {
      return [];
    }
    return {
      age: h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`,
      confidence: t.ask.after.confidence,
      deadline: s.deadline,
      extensions: s.extensions,
      id: t.ask.id,
      note: s.word,
      nudges: s.nudges,
      parent: t.ask.after.parent,
      quote: clip(t.ask.instruction.quote, 300),
      state: s.state,
      steers: s.steers.map((l) => ({ at: l.at, ...l.after })),
      steps: s.steps,
      title: t.ask.after.title,
    };
  });
}

/** Nudges each task past its deadline. */
export function nudge(now = Date.now()) {
  for (const t of tasksOf(undefined, deliveredLines())) {
    const why = standing(t, now).nudge;
    if (why) {
      taskLine(t.ask.id, "nudge", { why }, now);
    }
  }
}
