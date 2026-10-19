import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { actionId, alarmArgs, BOARD, type Reminder, remctl } from "./actions";
import { deliveredLines, parse, subscribed } from "./events";
import { log } from "./log";
import { ACTIONS, appendJsonl, linesOf, readActions } from "./memory/ledger";
import { sendReport, taskAlertReport } from "./memory/report";
import { clip, localTime } from "./memory/units";
import { Action, type Instruction, type TASK_LINES } from "./schema";
import { ROOT } from "./truth";

// Atlas's tasks: each ask (his "hey Atlas", or `bun life ask`) is a task in memory/actions.jsonl until Atlas closes it
// done or dropped. Its other lines: Atlas's updates (the connector's `task`), Life's nudges (past its deadline) and his
// steers (a change he made to its item on the board). The watcher's `tick` nudges, steers and mirrors: the board, his
// Reminders list `BOARD`, is a projection of the ledger that writes no ledger line and never goes through `act`.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** An unclaimed ask is nudged this long after it was recorded (Atlas picked events up 5 to 22 min late). */
const OPEN_MS = 30 * MIN;
const SPACING_MS = 30 * MIN;
/** Delivered nudges left unanswered before he is told. */
const NUDGES = 3;
const STUCK_MS = 7 * DAY;
/** An ask's words are clipped so its event stays far under the 256 KiB a webhook may carry; Atlas fetches the rest. */
const ASK_MAX = 50_000;
/** What the board looked like after Life's last pass, and what Life wrote there (mode 600: his words). */
const SNAPSHOT = join(ROOT, "derived", "board.json");

/** "hey Atlas": the two words in this order, whatever the case and the punctuation around or between them. */
export const WAKE = /\bhey\W+atlas\b/i;
/** Everything up to the wake and the spaces and punctuation after it. */
const TO_WAKE = new RegExp(String.raw`^.*?${WAKE.source}[\s\p{P}]*`, "isu");

/**
 * Records one ask for Atlas (the watcher delivers it): his words, where they are (`ref`: the wake turn, or the session)
 * and `after` (`confidence`, and for speech its `conversation` and `turns`). The same ref asks once: the old record
 * comes back.
 */
export async function ask(
  instruction: Instruction,
  after: Action["after"],
  madeBy: "session" | "watch",
  why: string
) {
  const id = actionId(instruction.ref, "ask", "");
  const old = readActions().find((a) => a.id === id);
  if (old) {
    return old;
  }
  const action: Action = {
    after,
    at: new Date().toISOString(),
    id,
    instruction: { ...instruction, quote: clip(instruction.quote, ASK_MAX) },
    kind: "ask",
    madeBy,
    result: "ok",
    schemaVersion: 1,
    target: "atlas",
    why,
  };
  await appendJsonl(ACTIONS, Action, [action]);
  return action;
}

export interface Task {
  ask: Action & { instruction: Instruction };
  /** Its update, nudge and steer lines in ledger order; `delivered`: the watcher has sent it (or passed it over). */
  lines: { a: Action; delivered: boolean }[];
}

/** The ledger as tasks: each ask with its own lines. */
export function tasksOf(lines: string[], delivered: number) {
  const tasks = new Map<string, Task>();
  for (const [i, a] of lines.map(parse).entries()) {
    if (a?.kind === "ask" && a.instruction) {
      tasks.set(a.id, { ask: { ...a, instruction: a.instruction }, lines: [] });
    } else if (a && tasks.has(a.target)) {
      tasks.get(a.target)?.lines.push({ a, delivered: i < delivered });
    }
  }
  return [...tasks.values()];
}

const closed = (s: State) => s === "done" || s === "dropped";

/** Where a task stands: its last update, deadline (an open one's: 30 min after it was recorded), nudges, steps. */
export function standing(t: Task) {
  const updates = t.lines.filter((l) => l.a.kind === "update").map((l) => l.a);
  const last = updates.at(-1);
  const since = last?.at ?? t.ask.at;
  const nudges = t.lines.filter((l) => l.a.kind === "nudge");
  return {
    deadline: last
      ? (last.after.deadline as string | undefined)
      : new Date(Date.parse(t.ask.at) + OPEN_MS).toISOString(),
    extensions: Math.max(0, updates.filter((u) => u.after.deadline).length - 1),
    last,
    nudges,
    since,
    state: (last?.after.state ?? "open") as State,
    steps: (updates.findLast((u) => u.after.steps)?.after.steps ??
      []) as NonNullable<Update["steps"]>,
    unanswered: nudges.filter((n) => n.delivered && n.a.at > since).length,
  };
}

/** The one rule: a task past its deadline is nudged, 30 min after the last nudge was delivered, until 3 go unanswered. */
export function nudgeWhy(t: Task, now: number) {
  const s = standing(t);
  const prev = s.nudges.at(-1);
  const due =
    !closed(s.state) &&
    Date.parse(s.deadline ?? "") <= now &&
    s.unanswered < NUDGES &&
    (!prev || (prev.delivered && now - Date.parse(prev.a.at) >= SPACING_MS));
  if (!due) {
    return null;
  }
  return s.state === "open"
    ? "not claimed 30 min after the ask"
    : `${s.state} past its deadline`;
}

/** Why he must look at a task now (its item goes to "Needs you" with a due), or null. */
export function escalation(t: Task, now: number, live: boolean) {
  const s = standing(t);
  if (closed(s.state)) {
    return null;
  }
  if (!live) {
    return "Atlas isn't receiving asks";
  }
  if (s.unanswered >= NUDGES) {
    return "Atlas stuck";
  }
  if (s.state === "waiting-eric" && now - Date.parse(s.since) > HOUR) {
    return `Atlas needs you: ${s.last?.after.question}`;
  }
  return now - Date.parse(t.ask.at) > STUCK_MS ? "stuck for 7 days" : null;
}

const Instant = z.iso.datetime({ offset: true });
const Text = z.string().min(1).max(2000);
/** One update from Atlas (the connector's `task`). */
export const Update = z.object({
  claim: z
    .boolean()
    .optional()
    .describe("true on the first update: it claims the open task"),
  deadline: Instant.optional().describe("ISO with an offset"),
  note: Text.optional(),
  on: z.string().max(200).optional().describe("What or whom it waits for"),
  outcome: Text.optional(),
  question: Text.optional().describe("waiting-eric: what you asked him"),
  reason: Text.optional(),
  state: z.enum(["working", "waiting-eric", "done", "dropped"]),
  steps: z
    .array(z.object({ done: z.boolean(), title: z.string().min(1).max(200) }))
    .max(30)
    .optional()
    .describe("The full list of steps, every time"),
  task: z.string().describe("The task's id"),
});
export type Update = z.infer<typeof Update>;
type State = Update["state"] | "open";

const NEEDS = {
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
  const missing = NEEDS[u.state].filter((k) => !u[k]);
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

/** One line of a task's own (`TASK_LINES`). */
const taskLine = (
  task: string,
  kind: (typeof TASK_LINES)[number],
  after: Action["after"],
  madeBy: "connector" | "watch",
  why: string,
  at = new Date().toISOString()
): Action => ({
  after,
  at,
  id: actionId(`${task}@${at}`, kind, ""),
  kind,
  madeBy,
  result: "ok",
  schemaVersion: 1,
  target: task,
  why,
});

let writing = Promise.resolve();
/**
 * Runs the task writes one at a time, each on the ledger as it stands then, so two runs cannot both claim a task and a
 * nudge never follows a claim it did not see (ponytail: a chain in this process, the watcher's, where the connector
 * and `tick` run; `bun life ask` only appends asks).
 */
function serial<T>(write: () => Promise<T>) {
  const run = writing.then(write);
  writing = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Records Atlas's update when the rules allow it; throws why not. */
export function update(u: Update, now = Date.now()) {
  return serial(async () => {
    const { task, ...after } = u;
    const why = refusal(
      tasksOf(linesOf(ACTIONS), 0).find((t) => t.ask.id === task),
      u,
      now
    );
    if (why) {
      throw new Error(why);
    }
    if (u.state === "waiting-eric") {
      after.deadline ??= new Date(now + DAY).toISOString();
    }
    await appendJsonl(ACTIONS, Action, [
      taskLine(
        task,
        "update",
        after,
        "connector",
        "Atlas",
        new Date(now).toISOString()
      ),
    ]);
    return `${task}: ${u.state}`;
  });
}

/**
 * The connector's `tasks`: with no id, the board (each open task's latest state, deadline, steps and last note, and
 * his steers since Atlas's last update); with an id, that task's whole history.
 */
export function board(id?: string) {
  const tasks = tasksOf(linesOf(ACTIONS), deliveredLines());
  if (id) {
    const t = tasks.find((x) => x.ask.id === id);
    if (!t) {
      throw new Error(`no task ${id}`);
    }
    const history = t.lines.map(({ a }) => ({
      at: a.at,
      kind: a.kind,
      ...a.after,
    }));
    return { ask: t.ask, history };
  }
  return {
    tasks: tasks.flatMap((t) => {
      const s = standing(t);
      const end = s.last?.after ?? {};
      const steers = t.lines.filter(
        (l) => l.a.kind === "steer" && l.a.at > s.since
      );
      return closed(s.state)
        ? []
        : [
            {
              at: t.ask.instruction.at,
              confidence: t.ask.after.confidence,
              deadline: s.deadline,
              id: t.ask.id,
              note: end.note ?? end.question,
              quote: t.ask.instruction.quote,
              state: s.state,
              steers: steers.map((l) => ({ at: l.a.at, ...l.a.after })),
              steps: s.steps,
            },
          ];
    }),
  };
}

/** The nightly's rows: every open task, then the ones closed in the last day with their outcome or reason. */
export function taskRows(now: number) {
  return tasksOf(linesOf(ACTIONS), deliveredLines()).flatMap((t) => {
    const s = standing(t);
    const words = clip(t.ask.instruction.quote, 120);
    if (closed(s.state)) {
      const end = s.last?.after;
      return now - Date.parse(s.since) < DAY
        ? [
            {
              name: s.state,
              relation: `${words} → ${end?.outcome ?? end?.reason}`,
            },
          ]
        : [];
    }
    const age = Math.floor((now - Date.parse(t.ask.at)) / HOUR);
    return [
      {
        name: `${s.state} · ${age < 48 ? `${age} h` : `${Math.floor(age / 24)} d`}`,
        relation: `${words} · deadline ${s.deadline ? localTime(s.deadline) : "none"} · ${s.nudges.length} nudges, ${s.extensions} extensions`,
      },
    ];
  });
}

// The mirror. Each task has one item on the board, found by the task id on its notes' first line. `wrote` is what Life
// last wrote there, `seen` how the item looked after that pass: Life writes a field only when what it wants differs
// from what it wrote, and anything that differs from `seen` is his change, a steer. So his edits are never overwritten.

/** An item's fields, as Life wants them, wrote them or saw them; `steps`: its subtasks by title, ticked or not. */
export interface Face {
  completed: boolean;
  due: string | null;
  notes: string;
  section: string;
  steps: Record<string, boolean>;
  title: string;
}
interface Shot {
  id: number;
  seen: Face;
  wrote: Face;
}
interface Item {
  face: Face;
  id: number;
  subIds: Record<string, number>;
}

/** Remctl's local "YYYY-MM-DD HH:MM", on the Mac's clock (remctl reads a due in the Mac's zone). */
const macTime = (ms: number) =>
  new Date(ms).toLocaleString("sv-SE").slice(0, 16);

/** "Atlas: <his words after the wake>", "(to confirm)" when nobody was named as the speaker. */
function titleOf(t: Task) {
  const { quote } = t.ask.instruction;
  const low = t.ask.after.confidence === "low" ? " (to confirm)" : "";
  return `Atlas${low}: ${clip(quote.replace(TO_WAKE, "") || quote, 80)}`;
}

/** The item a task should have: notes (id, his words, state, latest note, his own note until Atlas's next update), section, due while he is needed. */
export function wantOf(
  t: Task,
  cause: string | null,
  now: number,
  wrote?: Face
): Face {
  const s = standing(t);
  const end = s.last?.after ?? {};
  const his = t.lines.findLast(
    (l) => l.a.kind === "steer" && l.a.at > s.since && l.a.after.note
  );
  const stateLine = [
    s.state,
    s.deadline && !closed(s.state) && `until ${localTime(s.deadline)}`,
    end.on && `on ${end.on}`,
    cause,
  ];
  const note = end.note ?? end.question ?? end.outcome ?? end.reason;
  return {
    completed: closed(s.state),
    due: cause ? (wrote?.due ?? macTime(now)) : null,
    notes: [
      t.ask.id,
      clip(t.ask.instruction.quote, 1000),
      stateLine.filter(Boolean).join(" · "),
      note,
      his && `You: ${his.a.after.note}`,
    ]
      .filter(Boolean)
      .join("\n"),
    section: cause ? "Needs you" : SECTIONS[s.state],
    steps: Object.fromEntries(s.steps.map((x) => [x.title, x.done])),
    title: titleOf(t),
  };
}
const SECTIONS = {
  done: "Working",
  dropped: "Working",
  open: "Open",
  "waiting-eric": "Working",
  working: "Working",
};

/** "ticked", "unticked", "added" or "removed": how a checkbox changed, absent before or after. */
function toggled(was?: boolean, is?: boolean) {
  if (is === undefined) {
    return "removed";
  }
  if (was === undefined) {
    return "added";
  }
  return is ? "ticked" : "unticked";
}

/** His changes between how Life left an item and how it looks now; his note's new lines apart. */
export function steerOf(seen: Face, look: Face) {
  const before = new Set(seen.notes.split("\n"));
  const note = look.notes
    .split("\n")
    .filter((l) => l.trim() && !before.has(l))
    .join(" / ");
  const steps = new Set([
    ...Object.keys(seen.steps),
    ...Object.keys(look.steps),
  ]);
  const changes = [
    look.completed !== seen.completed &&
      toggled(seen.completed, look.completed),
    look.title !== seen.title && `title: ${look.title}`,
    look.due !== seen.due && `due: ${look.due ?? "cleared"}`,
    look.notes !== seen.notes && `notes: ${note || "lines removed"}`,
    ...[...steps]
      .filter((x) => seen.steps[x] !== look.steps[x])
      .map((x) => `${toggled(seen.steps[x], look.steps[x])} step: ${x}`),
  ].filter((c) => typeof c === "string");
  return { changes, note };
}

const SCALARS = ["completed", "due", "notes", "section"] as const;
const FINISH: Record<string, string> = { false: "undone", true: "done" };

/**
 * What to write to bring an item from `wrote` to `want` (edit flags, done or undone, steps to add and to tick) and
 * what Life then expects to see. Life adds and ticks only the subtasks it made from `steps`.
 */
export function planOf(
  want: Face,
  wrote: Face,
  look: Face,
  subIds: Record<string, number>
) {
  // Asking him to look brings back an item he ticked.
  const base =
    want.due && !wrote.due ? { ...wrote, completed: look.completed } : wrote;
  const set = Object.fromEntries(
    SCALARS.filter((k) => want[k] !== base[k]).map((k) => [k, want[k]])
  );
  const titles = Object.keys(want.steps);
  const add = titles.filter((x) => !(x in wrote.steps || x in look.steps));
  const ticks = titles.filter(
    (x) => want.steps[x] && wrote.steps[x] === false && look.steps[x] === false
  );
  const made: Record<string, boolean> = Object.fromEntries([
    ...add.map((x) => [x, false]),
    ...ticks.map((x) => [x, true]),
  ]);
  const unmade: Record<string, boolean> = Object.fromEntries(
    titles.map((x) => [x, false])
  );
  return {
    add,
    finish: "completed" in set ? FINISH[String(want.completed)] : null,
    flags: [
      ...("notes" in set ? [`--notes=${want.notes}`] : []),
      ...("due" in set ? dueFlags(want.due) : []),
      ...("section" in set ? ["--private", `--section=${want.section}`] : []),
    ],
    seen: { ...look, ...set, steps: { ...look.steps, ...made } },
    tick: ticks.flatMap((x) => subIds[x] ?? []),
    wrote: { ...want, steps: { ...unmade, ...wrote.steps, ...made } },
  };
}

const dueFlags = (due: string | null) =>
  due ? [`--due=${due}`, ...alarmArgs(due)] : ["--due=clear", "--alarm=clear"];

interface Subtasks {
  subtasks: { completed: boolean; id: number; title: string }[];
}

/** The board's items by task id; subtasks only for open tasks' items (a closed one's keep what Life saw). */
async function readBoard(open: Set<string>, shots: Record<string, Shot>) {
  const rows = await remctl<Reminder[]>(["show", BOARD, "--completed"]);
  const items = await Promise.all(
    rows.map(async (r): Promise<[string, Item]> => {
      const task = r.notes?.split("\n")[0] ?? "";
      const subs = open.has(task)
        ? (await remctl<Subtasks>(["subtasks", `${r.id}`])).subtasks
        : [];
      const face = {
        completed: r.completed,
        due: r.displayDate?.slice(0, 16).replace("T", " ") ?? null,
        notes: (r.notes ?? "").trim(),
        section: r.section ?? "",
        steps: open.has(task)
          ? Object.fromEntries(subs.map((x) => [x.title, x.completed]))
          : (shots[task]?.seen.steps ?? {}),
        title: r.title,
      };
      const subIds = Object.fromEntries(subs.map((x) => [x.title, x.id]));
      return [task, { face, id: r.id, subIds }];
    })
  );
  return new Map(items);
}

/** A new item, with the task id in its notes so a failed pass finds it again. */
async function added({ notes, title }: Face): Promise<Item> {
  const r = await remctl([
    "add",
    `--list=${BOARD}`,
    `--notes=${notes}`,
    "--",
    title,
  ]);
  const face = { ...BLANK, notes, title };
  return { face, id: Number(r.numericId), subIds: {} };
}
const BLANK = { completed: false, due: null, section: "", steps: {} };

/** Adds and ticks Life's steps: a failure is only partial, logged, and they are tried again next pass. */
async function writeSteps(t: Task, id: string, p: ReturnType<typeof planOf>) {
  try {
    if (p.add.length > 0) {
      await remctl([
        "edit",
        id,
        "--private",
        ...p.add.map((x) => `--subtask=${x}`),
      ]);
    }
    if (p.tick.length > 0) {
      await remctl(["done", ...p.tick.map(String)]);
    }
    return true;
  } catch (e) {
    const error = `partial: steps: ${(e as Error).message}`;
    log("run.error", { error, step: "tasks.mirror", task: t.ask.id });
    return false;
  }
}

/**
 * Brings one task's item to what Life wants (a closed task with no item gets none): its new snapshot entry. When a
 * write fails while he is needed, he is emailed once per incident (the task, the cause, since its last update).
 */
async function mirror(
  t: Task,
  item: Item | undefined,
  shot: Shot | undefined,
  cause: string | null,
  now: number
): Promise<Shot | undefined> {
  const wrote = shot?.id === item?.id ? shot?.wrote : item?.face;
  const want = wantOf(t, cause, now, wrote);
  if (!item && want.completed) {
    return;
  }
  try {
    const it = item ?? (await added(want));
    const base = wrote ?? it.face;
    const p = planOf(want, base, it.face, it.subIds);
    if (p.flags.length > 0) {
      await remctl(["edit", `${it.id}`, ...p.flags]);
    }
    if (p.finish) {
      await remctl([p.finish, `${it.id}`]);
    }
    return (await writeSteps(t, `${it.id}`, p))
      ? { id: it.id, seen: p.seen, wrote: p.wrote }
      : {
          id: it.id,
          seen: { ...p.seen, steps: it.face.steps },
          wrote: { ...p.wrote, steps: base.steps },
        };
  } catch (e) {
    const error = (e as Error).message;
    log("run.error", { error, step: "tasks.mirror", task: t.ask.id });
    if (cause && !wrote?.due) {
      const key = `${t.ask.id}/${cause.split(":")[0]}/${standing(t).since}`;
      await sendReport(
        `atlas/${key}`,
        taskAlertReport(want.title, cause, error)
      );
    }
    return item && wrote && { id: item.id, seen: item.face, wrote };
  }
}

/** His changes since Life's last pass, as steer lines: a changed item, or a deleted one (it comes back). */
export function steersOf(
  shots: Record<string, Shot>,
  items: Map<string, Item>
) {
  return Object.entries(shots).flatMap(([task, shot]) => {
    const item = items.get(task);
    const steer = item
      ? item.id === shot.id && steerOf(shot.seen, item.face)
      : { changes: ["deleted"], note: "" };
    return steer && steer.changes.length > 0
      ? [taskLine(task, "steer", steer, "watch", "he changed the board")]
      : [];
  });
}

const readShots = (): Record<string, Shot> =>
  existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, "utf8")) : {};

let last = { at: 0, lines: 0 };
/**
 * The watcher's pass, each minute or when the ledger grew: first the chase (nudges, from the ledger alone, so a
 * Reminders outage stops none), then the board: his changes become steers (a deleted item too: it comes back), and
 * every item is brought in line with the ledger. A lost snapshot is a fresh baseline: no steer that pass.
 */
export async function tick(now = Date.now()) {
  const grew = linesOf(ACTIONS).length;
  if (now - last.at < MIN && grew === last.lines) {
    return;
  }
  last = { at: now, lines: grew };
  await serial(() =>
    appendJsonl(
      ACTIONS,
      Action,
      tasksOf(linesOf(ACTIONS), deliveredLines()).flatMap((t) => {
        const why = nudgeWhy(t, now);
        return why ? [taskLine(t.ask.id, "nudge", { why }, "watch", why)] : [];
      })
    )
  );
  const shots = readShots();
  const open = new Set(
    tasksOf(linesOf(ACTIONS), 0)
      .filter((t) => !closed(standing(t).state))
      .map((t) => t.ask.id)
  );
  const items = await readBoard(open, shots);
  await serial(() => appendJsonl(ACTIONS, Action, steersOf(shots, items)));
  const live = subscribed(now);
  const next: Record<string, Shot> = {};
  for (const t of tasksOf(linesOf(ACTIONS), deliveredLines())) {
    // biome-ignore lint/performance/noAwaitInLoops: one item at a time
    const shot = await mirror(
      t,
      items.get(t.ask.id),
      shots[t.ask.id],
      escalation(t, now, live),
      now
    );
    if (shot) {
      next[t.ask.id] = shot;
    }
  }
  writeFileSync(SNAPSHOT, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  last.lines = linesOf(ACTIONS).length;
}
