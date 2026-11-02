import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { clock, DAY, HOUR, iso, MIN } from "../core/clock";
import { appendJsonl } from "../core/files";
import { digest } from "../core/hash";
import { type Call, recentEvents } from "../core/log";
import { AGENT_WORD } from "../core/names";
import { isOn } from "../core/outputs";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { agentNames } from "../core/settings";
import { LEDGER, type Task, tasksOf } from "../memory/ledger";
import {
  agentOf,
  closed,
  nameOf,
  settled,
  standing,
  type TaskState,
  type Update,
} from "../memory/tasks";
import { clip, localTime } from "../memory/units";
import { dayNow } from "../memory/zones";
import { type Instruction, LedgerEntry } from "../records/ledger-entry";
import type { Receipt } from "../todo-list/board";
import { entryId, requested } from "./act";
import { lapseReport, sendReport, taskReport, unsent } from "./report";

// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `update_agent_task` from his chat words or a split) is a task in memory/ledger.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `update_agent_task`) and replies to him (`log_reply_to_owner`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
/**
 * The protocol's parts (`<!-- <name> -->…<!-- /<name> -->`): `reminders` while the to-do list is on. The markers always
 * go, a part too when it is off.
 */
const PART = /<!-- (reminders) -->([\s\S]*?)<!-- \/\1 -->/g;
const partsOn = () => ({ reminders: isOn("todo_list") });
export function protocol(text: string, agent: string, on = partsOn()) {
  const cut = (t: string): string =>
    t.replace(PART, (_, name: keyof typeof on, part: string) =>
      on[name] ? cut(part) : ""
    );
  return cut(text).replaceAll("{agent}", agent);
}

/** An agent's playbook (the protocol, `docs/agent.md`, then his own part, `playbook.md` in his data), read on every call: `read_open_agent_tasks` returns it, `update_agent_task` refuses a write without its seal. */
const playbook = (agent: string) => {
  const own = join(OWNER_DATA_DIR, "playbook.md");
  return [
    protocol(
      readFileSync(join(LIFE_CODE_DIR, "docs", "agent.md"), "utf8"),
      agent
    ),
    ...(existsSync(own) ? [readFileSync(own, "utf8")] : []),
  ].join("\n");
};
const WINDOW = 6 * HOUR;
/** An agent's playbook and its seal: a hash of the text and its 6 h window, so a seal recalled from memory dies within 12 h. */
export const sealed = (
  agent: string,
  now = clock().getTime(),
  text = playbook(agent)
) => ({
  playbook: text,
  seal: digest("sha256", `${text}@${Math.floor(now / WINDOW)}`, 16),
});

/**
 * One ask line: his words, where they are (`ref`: the wake turn, the session, the chat message) and `after`
 * (`agent`, `confidence`; for speech `conversation` and `turns`; for a part of one message or a split, `title`).
 */
const askLine = (
  instruction: Instruction,
  after: LedgerEntry["after"] & { agent: string },
  via: "connector" | "session" | "watch",
  why: string,
  now = clock().getTime(),
  timing?: LedgerEntry["timing"]
) =>
  ({
    after,
    at: iso(now),
    // A split's id comes from its parent, so it never meets its parent's or a sibling's.
    id: entryId(
      `${after.parent ?? instruction.ref}`,
      "ask",
      `${after.title ?? ""}`
    ),
    // Clipped so its event stays far under the 256 KiB a webhook may carry; the agent fetches the rest.
    instruction: { ...instruction, quote: clip(instruction.quote, 50_000) },
    kind: "ask",
    result: "ok",
    schemaVersion: 1,
    target: AGENT_WORD,
    via,
    ...(timing ? { timing } : {}),
    why,
  }) satisfies LedgerEntry;

/** Records one ask for the agent (the watcher delivers it). The same ref and title ask once. */
export function ask(...a: Parameters<typeof askLine>) {
  const action = askLine(...a);
  const old = taskOf(tasksOf(), action.id)?.ask;
  if (!old) {
    appendJsonl(LEDGER, LedgerEntry, [action]);
  }
  return old ?? action;
}

/** The agent's own line on a task (or `chat`), as a ledger line: an update, or a reply (its id also over its text). */
const taskLine = (
  kind: "update" | "reply",
  task: string,
  after: LedgerEntry["after"],
  now: number,
  // The agent, through the connector; or his own tick or removal of the receipt (`closings`).
  by: Pick<LedgerEntry, "via" | "why">,
  salt = ""
): LedgerEntry => ({
  after,
  at: iso(now),
  id: entryId(`${task}@${iso(now)}`, kind, salt),
  kind,
  ...by,
  result: "ok",
  schemaVersion: 1,
  target: task,
});

/** The task with this id: one lookup for the ask, `update_agent_task`'s writes and a split's parent. */
const taskOf = (tasks: Task[], id?: string) =>
  tasks.find((t) => t.ask.id === id);

/**
 * Where each ask's time went, in the order recorded (`bun life asks`): when he spoke, his words ended, lifelog's feed had all
 * of them, Life recorded the ask, the agent claimed it and closed it; null where unknown
 * (not speech, not yet, or before 20 Oct). A split's parts are left out: they share their parent's times.
 */
export function timings(from = "", to = "9999", tasks = tasksOf()) {
  return tasks
    .filter((t) => !t.ask.after.parent && t.ask.at >= from && t.ask.at < to)
    .map(({ ask: a, lines }) => {
      const updates = lines.filter((l) => l.kind === "update");
      return {
        id: a.id,
        // In order (an array: the formatter sorts object keys).
        moments: [
          ["spoke", a.instruction.at],
          ["ended", a.timing?.ended ?? null],
          ["arrived", a.timing?.arrived ?? null],
          ["recorded", a.at],
          // The agent's first update; one Life wrote from his tick in Reminders does not take it.
          ["taken", updates.find((u) => u.via !== "reminders")?.at ?? null],
          [
            "closed",
            updates.find((u) => closed(u.after.state as TaskState))?.at ?? null,
          ],
        ] as [string, string | null][],
        quote: a.instruction.quote,
        via: a.via,
      };
    });
}

const WEEK = "stuck for 7 days";

/**
 * Why he must look at a task now, or null: every task, chat ones too. The agent waits on him over an hour, let it pass
 * its deadline (unclaimed 30 min after the ask, or claimed and silent), or it is a week old.
 */
export function escalation(t: Task, now: number) {
  const { deadline, end, since, state } = standing(t);
  if (closed(state)) {
    return null;
  }
  if (state === "waiting-owner" && now - Date.parse(since) > HOUR) {
    return `${agentOf(t)} needs you: ${end.question}`;
  }
  if (Date.parse(deadline ?? "") <= now) {
    return state === "open"
      ? "not taken 30 min after the ask"
      : `${state} past its deadline`;
  }
  return now - Date.parse(t.ask.at) > 7 * DAY ? WEEK : null;
}

/**
 * What needs him now about one agent's tasks, each with the key it is emailed once under. With the agent not checking
 * in, one alert a day (his day) for all its open tasks; else each task that needs him, keyed by task, cause and the
 * agent's last update (a week-old task once, however often the agent extends it).
 */
export function alerts(
  agent: string,
  tasks: Task[],
  now: number,
  live: boolean
) {
  if (!live) {
    const open = tasks.filter((t) => !closed(standing(t).state)).length;
    const cause = `${agent} isn't receiving asks`;
    return open
      ? [{ cause, key: `lapse/${agent}/${dayNow(new Date(now))}`, open }]
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

const REQUIRED = {
  done: ["outcome"],
  dropped: ["reason"],
  "waiting-owner": ["question"],
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
  if (Boolean(u.taken) !== (state === "open")) {
    return state === "open"
      ? "the first update takes the task: taken: true"
      : `already taken: the task is ${state}`;
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

/** The task `u` makes for `agent`: from his words in a chat, or a split of an open task (its words and agent, never new ones); throws why not. */
function made(u: Update, tasks: Task[], now: number, agent: string) {
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
    const after = {
      ...p.ask.after,
      agent: agentOf(p),
      parent: p.ask.id,
      title: u.title,
    };
    return askLine(
      p.ask.instruction,
      after,
      "connector",
      `split by ${agent}`,
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
  const after = { agent, confidence: "high", title: u.title };
  return askLine(chat, after, "connector", `asked ${agent} in a chat`, now);
}

/**
 * The ledger lines `agent`'s update appends (a task it makes first, claimed by this update, so a retry finds it) and
 * Life's answer; throws why not (another agent's task among them), with the playbook and its seal when the seal is not
 * current.
 */
export function written(
  u: Update,
  tasks: Task[],
  now: number,
  agent: string,
  text = playbook(agent)
) {
  if (
    ![now, now - WINDOW].some((w) => sealed(agent, w, text).seal === u.seal)
  ) {
    const { seal } = sealed(agent, now, text);
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
  const fresh = task ? undefined : made(u, tasks, now, agent);
  if (fresh && taskOf(tasks, fresh.id)) {
    return { answer: `${fresh.id}: already a task`, lines: [] };
  }
  const id = fresh?.id ?? `${task}`;
  const t = fresh ? { ask: fresh, lines: [] } : taskOf(tasks, id);
  const why =
    t && agentOf(t) !== agent
      ? `${id} is ${agentOf(t)}'s task, not ${agent}'s`
      : refusal(t, u, now);
  if (why) {
    throw new Error(why);
  }
  if (u.state === "waiting-owner") {
    after.deadline ??= iso(now + DAY);
  }
  const line = taskLine("update", id, after, now, {
    via: "connector",
    why: agent,
  });
  return { answer: `${id}: ${u.state}`, lines: fresh ? [fresh, line] : [line] };
}

/** Records `agent`'s update when the rules allow it (synchronous, from reading the ledger to the lines); throws why not. */
export function update(u: Update, agent: string, now = clock().getTime()) {
  const { answer, lines } = written(u, tasksOf(), now, agent);
  appendJsonl(LEDGER, LedgerEntry, lines);
  return answer;
}

export const Reply = z.object({
  task: z.string().optional().describe("The task it answers, if any"),
  text: z.string().min(1).describe("What you are telling him, as sent"),
});

/** Records what an app tells him (the connector's `log_reply_to_owner`, `by` its agent), on a task or none (`chat`); throws when the task is unknown. */
export function reply(
  { task, text }: z.infer<typeof Reply>,
  by: string,
  now = clock().getTime()
) {
  if (task && !taskOf(tasksOf(), task)) {
    throw new Error(`no task ${task}`);
  }
  const target = task ?? "chat";
  appendJsonl(LEDGER, LedgerEntry, [
    taskLine(
      "reply",
      target,
      { text: clip(text, 4000) },
      now,
      { via: "connector", why: by },
      text
    ),
  ]);
  return `${target}: reply logged`;
}

/** The asks recorded since `since` (his spoken ones, Life's and the tasks the agent made from his chat words; not splits) with no reply line: the nightly's gap count. */
export const unanswered = (since: number, tasks = tasksOf()) =>
  tasks.filter(
    (t) =>
      !t.ask.after.parent &&
      Date.parse(t.ask.at) >= since &&
      !t.lines.some((l) => l.kind === "reply")
  ).length;

/**
 * Every open task, and the ones closed in the last day, of one agent or all: the nightly's rows, and the connector's
 * `read_open_agent_tasks` (it cuts the closed rows short).
 */
export function taskList(now = clock().getTime(), agent?: string) {
  return tasksOf().flatMap((t) => {
    const s = standing(t);
    const h = Math.floor((now - Date.parse(t.ask.at)) / HOUR);
    if (settled(s, now) || (agent && agentOf(t) !== agent)) {
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

/**
 * Emails him what newly needs him, one email a pass per agent, each key once (`sendReport`): an agent not checking in
 * alone, else every task of its with a new cause (one that goes silent again after an update is new).
 */
export async function chase(tasks: Task[], now: number, live?: boolean) {
  for (const agent of agentNames()) {
    // biome-ignore lint/performance/noAwaitInLoops: one email at a time
    await chaseFor(
      agent,
      tasks.filter((t) => agentOf(t) === agent),
      now,
      live ?? (await agentLive(now, agent))
    );
  }
}

async function chaseFor(
  agent: string,
  tasks: Task[],
  now: number,
  live: boolean
) {
  const due = alerts(agent, tasks, now, live);
  const fresh = new Set(await unsent(due.map((a) => a.key)));
  const news = due.filter((a) => fresh.has(a.key));
  const [first] = news;
  if (!first) {
    return;
  }
  await sendReport(
    news.map((a) => a.key),
    "open" in first
      ? lapseReport(agent, first.open, now)
      : taskReport(
          agent,
          news.flatMap((a) =>
            "t" in a
              ? [{ ask: a.t.ask, cause: a.cause, title: nameOf(a.t) }]
              : []
          ),
          now
        )
  );
}

/** What a task's item on its agent's board should say: notes (id, his words, state, latest note). */
export function wantOf(t: Task): Receipt {
  const { deadline, end, state, word } = standing(t);
  const { quote } = t.ask.instruction;
  const until = !closed(state) && deadline && `until ${localTime(deadline)}`;
  const line = [state, until, end.on && `on ${end.on}`];
  const notes = [
    t.ask.id,
    clip(quote, 1000),
    line.filter(Boolean).join(" · "),
    word,
  ];
  const low = t.ask.after.confidence === "low" ? " (to confirm)" : "";
  return {
    board: agentOf(t),
    completed: closed(state),
    id: t.ask.id,
    notes: notes.filter(Boolean).join("\n").trim(),
    section: state === "open" ? "Open" : "Working",
    title: `${agentOf(t)}${low}: ${nameOf(t)}`,
  };
}

/** The board's receipts (`push`, apps/server/src/todo-list/board.ts, which also leaves alone a ticked item of a closed task): every task but those closed over a day ago. */
export const receipts = (tasks: Task[], now: number) =>
  tasks.filter((t) => !settled(standing(t), now)).map(wantOf);

/** His tick or removal of an open task's receipt (`marks`, apps/server/src/todo-list/board.ts) closes it, done or dropped (decision 17): it only takes work away. */
export const closings = (
  tasks: Task[],
  marks: Map<string, "removed" | "ticked">,
  at: string
): LedgerEntry[] =>
  tasks.flatMap((t) => {
    const mark = marks.get(t.ask.id);
    const after =
      mark === "ticked"
        ? { outcome: "he ticked its receipt in Reminders", state: "done" }
        : { reason: "he removed its receipt in Reminders", state: "dropped" };
    const by = { via: "reminders", why: "his change in Reminders" } as const;
    return mark && !closed(standing(t).state)
      ? [taskLine("update", t.ask.id, after, Date.parse(at), by, "reminders")]
      : [];
  });

/** How long an agent may go without reading `read_open_agent_tasks` before Life says it isn't receiving asks. */
const PULL_MS = DAY;

/** Whether his asks reach `agent` now: a `read_open_agent_tasks` call of its own (its grant's agent claim) in the last day (`calls`: the connector's log). */
export async function agentLive(
  now: number,
  agent: string,
  calls = () => recentEvents<Call>(2, "mcp.call")
) {
  return (await calls()).some(
    (e) =>
      e.tool === "read_open_agent_tasks" &&
      !e.error &&
      e.agent === agent &&
      now - Date.parse(e.at) < PULL_MS
  );
}
