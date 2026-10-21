import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { actionId, requested } from "./actions";
import { clock } from "./clock";
import { LOG_DIR, logDays, logEvents } from "./log";
import {
  ACTIONS,
  appendJsonl,
  digest,
  lastUpdate,
  type Task,
  tasksOf,
} from "./memory/ledger";
import { clip } from "./memory/units";
import { localDate } from "./memory/zones";
import { Action, type Instruction } from "./schema";
import { ROOT } from "./truth";

// Atlas's tasks: each ask (his "hey Atlas", `bun life ask`, or Atlas's `task` from his chat words or a split) is a task in memory/actions.jsonl until Atlas closes it
// done or dropped. Its own lines: Atlas's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`, src/board.ts).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** An ask is due to be claimed 30 min after it was recorded (since events, a healthy claim takes 3 to 27 min, a median of 7). */
const CLAIM_MS = 30 * MIN;

const iso = (ms: number) => new Date(ms).toISOString();

/** Atlas's playbook, read from its one source on every call: `tasks` returns it, `task` refuses a write without its seal. */
const playbook = () => readFileSync(join(ROOT, "docs", "atlas.md"), "utf8");
const WINDOW = 6 * HOUR;
/** The playbook and its seal: a hash of the text and its 6 h window, so a seal recalled from memory dies within 12 h. */
export const sealed = (now = clock().getTime(), text = playbook()) => ({
  playbook: text,
  seal: digest("sha256", `${text}@${Math.floor(now / WINDOW)}`, 16),
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
  now = clock().getTime(),
  timing?: Action["timing"]
) =>
  ({
    after,
    at: iso(now),
    // A split's id comes from its parent, so it never meets its parent's or a sibling's.
    id: actionId(
      `${after.parent ?? instruction.ref}`,
      "ask",
      `${after.title ?? ""}`
    ),
    // Clipped so its event stays far under the 256 KiB a webhook may carry; Atlas fetches the rest.
    instruction: { ...instruction, quote: clip(instruction.quote, 50_000) },
    kind: "ask",
    madeBy,
    result: "ok",
    schemaVersion: 1,
    target: "atlas",
    ...(timing ? { timing } : {}),
    why,
  }) satisfies Action;

/** Records one ask for Atlas (the watcher delivers it). The same ref and title ask once. */
export function ask(...a: Parameters<typeof askLine>) {
  const action = askLine(...a);
  const old = taskOf(tasksOf(), action.id)?.ask;
  if (!old) {
    appendJsonl(ACTIONS, Action, [action]);
  }
  return old ?? action;
}

/** Atlas's own line on a task (or `chat`), as a ledger line: an update, or a reply (its id also over its text). */
const taskLine = (
  kind: "update" | "reply",
  task: string,
  after: Action["after"],
  now: number,
  salt = ""
): Action => ({
  after,
  at: iso(now),
  id: actionId(`${task}@${iso(now)}`, kind, salt),
  kind,
  madeBy: "connector",
  result: "ok",
  schemaVersion: 1,
  target: task,
  why: "Atlas",
});

/** The task with this id: one lookup for the ask, `task`'s writes and a split's parent. */
const taskOf = (tasks: Task[], id?: string) =>
  tasks.find((t) => t.ask.id === id);

export const closed = (s: State) => s === "done" || s === "dropped";

/**
 * Where each ask's time went, in the order recorded (`bun life asks`): when he spoke, his words ended, lifelog's feed had all
 * of them, Life recorded the ask, Atlas got it (the `event.sent` log), claimed it and closed it; null where unknown
 * (not speech, not yet, or before 20 Oct). A split's parts are left out: they share their parent's times.
 */
export async function timings(
  from = "",
  to = "9999",
  tasks = tasksOf(),
  dir = LOG_DIR
) {
  // Oldest first, the first delivery kept: a retry after a lost answer is not when Atlas got it.
  const sent = new Map<string, string>();
  const days = (await logDays(dir))
    .filter((n) => n >= from.slice(0, 10))
    .reverse();
  for (const e of days.flatMap((n) => logEvents(n, "event.sent", dir))) {
    sent.set(`${e.event}`, sent.get(`${e.event}`) ?? e.at);
  }
  return tasks
    .filter((t) => !t.ask.after.parent && t.ask.at >= from && t.ask.at < to)
    .map(({ ask: a, lines }) => {
      const updates = lines.filter((l) => l.kind === "update");
      return {
        id: a.id,
        madeBy: a.madeBy,
        // In order (an array: the formatter sorts object keys).
        moments: [
          ["spoke", a.instruction.at],
          ["ended", a.timing?.ended ?? null],
          ["arrived", a.timing?.arrived ?? null],
          ["recorded", a.at],
          ["delivered", sent.get(a.id) ?? null],
          ["claimed", updates[0]?.at ?? null],
          [
            "closed",
            updates.find((u) => closed(u.after.state as State))?.at ?? null,
          ],
        ] as [string, string | null][],
        quote: a.instruction.quote,
      };
    });
}

/** Where a task stands: its last update (`end`), deadline (an open one's: 30 min after it was recorded), steps. */
export function standing(t: Task) {
  const last = lastUpdate(t);
  const end: Partial<Update> = last?.after ?? {};
  const since = last?.at ?? t.ask.at;
  const state = end.state ?? ("open" as State);
  const deadline = last ? end.deadline : iso(Date.parse(since) + CLAIM_MS);
  return {
    deadline,
    end,
    since,
    state,
    steps: (t.lines.findLast((u) => u.kind === "update" && u.after.steps)?.after
      .steps ?? []) as Step[],
    /** Atlas's last word: the outcome or reason once closed. */
    word: end.outcome ?? end.reason ?? end.question ?? end.note,
  };
}

/** Closed over a day ago: out of the lists, and its board item left to him. */
export const settled = (s: { since: string; state: State }, now: number) =>
  closed(s.state) && now - Date.parse(s.since) > DAY;

const WEEK = "stuck for 7 days";
const LAPSE = "Atlas isn't receiving asks";

/**
 * Why he must look at a task now, or null: every task, chat ones too. Atlas waits on him over an hour, let it pass
 * its deadline (unclaimed 30 min after the ask, or claimed and silent), or it is a week old.
 */
export function escalation(t: Task, now: number) {
  const { deadline, end, since, state } = standing(t);
  if (closed(state)) {
    return null;
  }
  if (state === "waiting-eric" && now - Date.parse(since) > HOUR) {
    return `Atlas needs you: ${end.question}`;
  }
  if (Date.parse(deadline ?? "") <= now) {
    return state === "open"
      ? "not claimed 30 min after the ask"
      : `${state} past its deadline`;
  }
  return now - Date.parse(t.ask.at) > 7 * DAY ? WEEK : null;
}

/**
 * What needs him now, each with the key it is emailed once under. With no live subscription, one alert a day (his
 * day) for all the open tasks; else each task that needs him, keyed by task, cause and Atlas's last update (a
 * week-old task once, however often Atlas extends it).
 */
export function alerts(tasks: Task[], now: number, live: boolean) {
  if (!live) {
    const open = tasks.filter((t) => !closed(standing(t).state)).length;
    return open
      ? [{ cause: LAPSE, key: `lapse/${localDate(iso(now))}`, open }]
      : [];
  }
  return tasks.flatMap((t) => {
    const cause = escalation(t, now);
    if (!cause) {
      return [];
    }
    const since = cause === WEEK ? "" : standing(t).since;
    return [
      { cause, key: `task/${t.ask.id}/${cause.split(":")[0]}/${since}`, t },
    ];
  });
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
  const { state } = standing(t);
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
function made(u: Update, tasks: Task[], now: number) {
  const p = taskOf(tasks, u.parent);
  if (p) {
    const { state } = standing(p);
    if (!u.title) {
      throw new Error("a split needs title");
    }
    if (p.ask.after.parent || closed(state)) {
      throw new Error(
        `only an open task that is no split part splits: ${p.ask.id} is ${p.ask.after.parent ? "a part" : state}`
      );
    }
    const after = { ...p.ask.after, parent: p.ask.id, title: u.title };
    return askLine(
      p.ask.instruction,
      after,
      "connector",
      "split by Atlas",
      now
    );
  }
  if (u.parent) {
    throw new Error(`no task ${u.parent}`);
  }
  const sent = Date.parse(u.at ?? "");
  if (!(sent <= now + MIN && sent > now - 7 * DAY)) {
    throw new Error("said needs at: when he sent it, in the last 7 days");
  }
  // His message's instant, normalized: the same message makes the same id whatever the offset it was given in.
  const chat = requested("connector", `${u.said}`, iso(sent));
  const after = { confidence: "high", title: u.title };
  return askLine(chat, after, "connector", "asked Atlas in a chat", now);
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
  const fresh = task ? undefined : made(u, tasks, now);
  if (fresh && taskOf(tasks, fresh.id)) {
    return { answer: `${fresh.id}: already a task`, lines: [] };
  }
  const id = fresh?.id ?? `${task}`;
  const t = fresh ? { ask: fresh, lines: [] } : taskOf(tasks, id);
  const why = refusal(t, u, now);
  if (why) {
    throw new Error(why);
  }
  if (u.state === "waiting-eric") {
    after.deadline ??= iso(now + DAY);
  }
  const line = taskLine("update", id, after, now);
  return { answer: `${id}: ${u.state}`, lines: fresh ? [fresh, line] : [line] };
}

/** Records Atlas's update when the rules allow it (synchronous, from reading the ledger to the lines); throws why not. */
export function update(u: Update, now = clock().getTime()) {
  const { answer, lines } = written(u, tasksOf(), now);
  appendJsonl(ACTIONS, Action, lines);
  return answer;
}

export const Reply = z.object({
  task: z.string().optional().describe("The task it answers, if any"),
  text: z.string().min(1).describe("What you are telling him, as sent"),
});

/** Records what Atlas tells him (the connector's `reply`), on a task or none (`chat`); throws when the task is unknown. */
export function reply(
  { task, text }: z.infer<typeof Reply>,
  now = clock().getTime()
) {
  if (task && !taskOf(tasksOf(), task)) {
    throw new Error(`no task ${task}`);
  }
  const target = task ?? "chat";
  appendJsonl(ACTIONS, Action, [
    taskLine("reply", target, { text: clip(text, 4000) }, now, text),
  ]);
  return `${target}: reply logged`;
}

/** The asks recorded since `since` (his spoken ones, Life's and the tasks Atlas made from his chat words; not splits) with no reply line: the nightly's gap count. */
export const unanswered = (since: number, tasks = tasksOf()) =>
  tasks.filter(
    (t) =>
      !t.ask.after.parent &&
      Date.parse(t.ask.at) >= since &&
      !t.lines.some((l) => l.kind === "reply")
  ).length;

/**
 * Every open task, and the ones closed in the last day: the nightly's rows, and the connector's `tasks` (it cuts the
 * closed rows short).
 */
export function taskList(now = clock().getTime()) {
  return tasksOf().flatMap((t) => {
    const s = standing(t);
    const h = Math.floor((now - Date.parse(t.ask.at)) / HOUR);
    if (settled(s, now)) {
      return [];
    }
    return {
      age: h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`,
      confidence: t.ask.after.confidence,
      deadline: s.deadline,
      id: t.ask.id,
      note: s.word,
      parent: t.ask.after.parent,
      quote: clip(t.ask.instruction.quote, 300),
      state: s.state,
      steps: s.steps,
      title: t.ask.after.title as string | undefined,
    };
  });
}
