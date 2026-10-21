import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { clock, unfrozen } from "./clock";
import { ACTIONS, appendJsonl, digest, readActions } from "./memory/ledger";
import { actionFailedReport, sendReport } from "./memory/report";
import { normalize } from "./memory/units";
import { localDate } from "./memory/zones";
import { exec } from "./proc";
import {
  Action,
  type Instruction,
  type Observation,
  REMINDER_KINDS,
} from "./schema";
import { kindOf } from "./sources";
import { ownerSpoke, withStore } from "./sources/lifelog";

// The only code that writes outside Life on the owner's clear request: Apple Reminders through remctl (its signed
// host, `--json`). Every call is one `act`, which records an Action (memory/actions.jsonl) and tells the owner
// by email when it failed. Nothing here reads his words: the callers (the CLI, the connector) decide that he asked.
// The ledger also holds Atlas's tasks (src/tasks.ts), whose board, the list `BOARD`, no `act` may touch.

const REMCTL = join(homedir(), "bin", "remctl");
/** Atlas's board: Life's projection of its tasks (src/tasks.ts). */
export const BOARD = "Atlas";
/** How long a list's own sorter takes to place a new reminder (read-after-write lags about 2 s). */
const SORTER_MS = 3000;

const Due = z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/);

/** What to do, as the connector and the CLI both say it. */
export const Change = z.object({
  // With a time it alerts then; null clears it (edit only).
  due: Due.nullish(),
  kind: z.enum(REMINDER_KINDS),
  list: z.string().optional(),
  notes: z.string().max(2000).nullish(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  prompt: z.string().max(1500).optional(),
  // remctl's syntax: "daily", "weekly mon,wed", "monthly 6", "monthly last-fri", "daily x2"; "clear" stops it; its JSON
  // form ends: {"frequency":"daily","interval":1,"end":"2026-10-23T23:59"}. Needs a due date.
  recurrence: z.string().max(200).optional(),
  section: z.string().optional(),
  // A step may have its own `due`: a check-in on a promised answer, say.
  subtasks: z
    .array(z.object({ due: Due.optional(), title: z.string().min(1).max(200) }))
    .max(10)
    .optional(),
  target: z.int().positive().optional(),
  title: z.string().min(1).max(200),
  urgent: z.boolean().optional(),
});
export type Change = z.infer<typeof Change>;
type Done = Pick<Action, "after" | "before" | "error" | "target">;

const parse = <T>(s: string) => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
};

/**
 * One remctl call (`args[0]` is the command), its JSON. A partial add (created, a private step failed) comes back too;
 * anything else that fails throws remctl's own words. Read-after-write lags about 2 s: never verify with a read at once.
 * Killed after a minute (exec's default), so a stuck Reminders host cannot hold the queue.
 */
export async function remctl<T = Record<string, unknown>>(args: string[]) {
  unfrozen("touch his Reminders");
  const [command, ...rest] = args;
  const r = await exec([REMCTL, command ?? "", "--json", ...rest], {
    env: { ...process.env, NO_COLOR: "1", REMCTL_SKIP_ONBOARD: "1" },
  });
  const out = parse<T & { status?: string }>(r.stdout);
  if (r.code === 0 || out.status === "partial") {
    return out;
  }
  throw new Error(`remctl ${command}: ${r.stderr.trim().slice(-300)}`);
}

export const actionId = (ref: string, kind: string, title: string) =>
  `act_${digest("sha1", `${ref}|${kind}|${normalize(title)}`, 12)}`;

/** A timed reminder alerts at its time, as one made in Reminders does: EventKit adds no alarm by itself. */
const alarmAt = (due?: string | null) => (due?.includes(":") ? due : undefined);
/** The alarm flag of a due; none when the reminder already has alarms (remctl moves one that was at the old time; his own stay). */
export const alarmArgs = (due?: string | null, hasAlarms = false) =>
  !hasAlarms && alarmAt(due) ? [`--alarm=${due}`] : [];

/**
 * The remctl flags of a change's fields: `pub` goes through EventKit, `priv` (section, urgent, subtasks, the claude.ai
 * link of a `prompt`) through the private helper, so it is empty unless needed. `--name=value` keeps a value that starts
 * with a dash from being read as a flag. The link only pre-fills a Claude chat, it runs nothing.
 */
export function reminderArgs(c: Partial<Change>) {
  const priv = [
    ...(c.section ? [`--section=${c.section}`] : []),
    ...(c.urgent ? ["--urgent"] : []),
    ...(c.prompt
      ? [`--url=https://claude.ai/new?q=${encodeURIComponent(c.prompt)}`]
      : []),
    ...(c.subtasks ?? []).map(
      (s) => `--subtask=${JSON.stringify({ ...s, alarm: alarmAt(s.due) })}`
    ),
  ];
  return {
    priv: priv.length > 0 ? ["--private", ...priv] : [],
    pub: [
      ...(c.notes === undefined ? [] : [`--notes=${c.notes ?? ""}`]),
      ...(c.due === undefined ? [] : [`--due=${c.due ?? "clear"}`]),
      ...(c.priority ? [`--priority=${c.priority}`] : []),
      ...(c.recurrence ? [`--recurrence=${c.recurrence}`] : []),
    ],
  };
}

/** The fields a change writes, for the record. */
const fieldsOf = ({ kind, target, ...fields }: Partial<Change>) => fields;

/** What an edit changes: the new title and list when they differ from the reminder's, and every other field that is set. */
export function changedFields(
  c: Change,
  before: { list?: unknown; section?: unknown; title?: unknown }
) {
  const fields = fieldsOf(c);
  for (const k of ["title", "list", "section"] as const) {
    if (fields[k] === before[k]) {
      delete fields[k];
    }
  }
  return fields;
}

const KEEP =
  "id title list section dueDate alarms notes priority urgent completed".split(
    " "
  );

/** A reminder as it is now, for `before`. Throws when there is none with this id. */
async function info(target: number | undefined) {
  if (target === undefined) {
    throw new Error("this needs a target reminder id");
  }
  const r = await remctl(["info", "--", String(target)]);
  return Object.fromEntries(KEEP.flatMap((k) => (k in r ? [[k, r[k]]] : [])));
}

export const partial = (r: Record<string, unknown>) =>
  r.status === "partial"
    ? `partial: ${r.message ?? r.error ?? "a private step failed"}`
    : undefined;

/** A new reminder. */
export async function add(c: Change): Promise<Done> {
  const { priv, pub } = reminderArgs(c);
  const r = await remctl([
    "add",
    ...(c.list ? [`--list=${c.list}`] : []),
    ...pub,
    ...alarmArgs(c.due),
    ...priv,
    "--",
    c.title,
  ]);
  if (typeof r.numericId !== "number") {
    throw new Error("remctl add: no reminder id in its answer");
  }
  let error = partial(r);
  if (c.section) {
    // A list that auto-categorizes (remctl cannot turn that off) re-sorts a new reminder a moment after it exists,
    // over the section asked for: put it back once the sorter is done.
    await Bun.sleep(SORTER_MS);
    try {
      await remctl([
        "edit",
        `${r.numericId}`,
        "--private",
        `--section=${c.section}`,
      ]);
    } catch (e) {
      error ??= `partial: section: ${(e as Error).message}`;
    }
  }
  return {
    after: { ...fieldsOf(c), id: r.numericId },
    error,
    target: `reminder:${r.numericId}`,
  };
}

async function edit(c: Change): Promise<Done> {
  const before = await info(c.target);
  const changed = changedFields(c, before);
  let id = c.target;
  // A move can clone and delete, which gives the reminder a new id.
  if (changed.list) {
    const moved = await remctl(["edit", `${id}`, `--list=${changed.list}`]);
    id = Number(moved.id ?? id);
  }
  const { priv, pub } = reminderArgs(changed);
  const flags = [
    ...(changed.title ? [`--title=${changed.title}`] : []),
    ...pub,
    ...alarmArgs(changed.due, Boolean(before.alarms)),
    ...priv,
  ];
  const r = flags.length > 0 ? await remctl(["edit", `${id}`, ...flags]) : {};
  return {
    after: changed,
    before,
    error: partial(r),
    target: `reminder:${id}`,
  };
}

/** The kinds that only change a reminder's state, each with its remctl call and what it leaves: `finish`'s table. */
const FINISH = {
  done: { after: { completed: true }, args: (id: string) => ["done", id] },
  remove: {
    after: { deleted: true },
    args: (id: string) => ["delete", id, "--force"],
  },
  restore: {
    after: { deleted: false },
    args: (id: string, list?: string) => [
      "restore",
      "--private",
      `--list=${list}`,
      "--",
      id,
    ],
  },
  undone: { after: { completed: false }, args: (id: string) => ["undone", id] },
};

/** Ticks a reminder off or open, removes it (to Recently Deleted) or restores it from there into `list`. */
async function finish(
  c: Change & { kind: keyof typeof FINISH }
): Promise<Done> {
  // A removed reminder has no info until it is back.
  const before = c.kind === "restore" ? undefined : await info(c.target);
  const { after, args } = FINISH[c.kind];
  await remctl(args(`${c.target}`, c.list));
  return { after, before, target: `reminder:${c.target}` };
}

/** What a client passes (a Claude session through the CLI, a chat through the connector): a change, his words that asked for it, and why. */
export const Asked = Change.extend({
  said: z.string().min(3).describe("The owner's own words that asked for it"),
  why: z.string().default("asked in a Claude session"),
});
export type Asked = z.infer<typeof Asked>;

interface Act {
  change: Change;
  instruction: Instruction;
  madeBy: Action["madeBy"];
  why: string;
}

/** The open reminder an add would repeat (the same title), so nothing is written: the one duplicate check, for every caller. */
export function duplicateOf(c: Change, open?: Reminder[]) {
  const same =
    c.kind === "add"
      ? open?.find((r) => normalize(r.title) === normalize(c.title))
      : undefined;
  return same && `reminder:${same.id}`;
}

/** The record of an action already done (or asked) with this id: the same words act once, unless that try failed. */
export const recorded = async (id: string) =>
  (await readActions()).find((x) => x.id === id && x.result !== "failed");

/**
 * Does one change and records it in memory/actions.jsonl; a failure is recorded too, and emailed at once with his words
 * so he can do it by hand. The same words asking for the same thing act once (the old record comes back), unless that
 * try failed: then they try again.
 */
export async function act(a: Act): Promise<Action> {
  const { change: c, instruction } = a;
  // Refused before anything is recorded; a target it cannot read fails as usual, below.
  if (c.kind === "restore" && !(c.target && c.list)) {
    throw new Error(
      "a restore needs the reminder id and the list to put it in"
    );
  }
  const on = c.target && (await info(c.target).catch(() => undefined))?.list;
  if (c.list === BOARD || on === BOARD) {
    throw new Error(`the list ${BOARD} is Atlas's board: use \`task\``);
  }
  const id = actionId(instruction.ref, c.kind, c.title);
  const old = await recorded(id);
  if (old) {
    return old;
  }
  const open =
    c.kind === "add" ? await openReminders().catch(() => undefined) : undefined;
  const same = duplicateOf(c, open);
  let result: Action["result"] = "ok";
  let done: Done;
  try {
    if (same) {
      result = "duplicate";
      done = { after: { title: c.title }, target: same };
    } else if (c.kind === "add") {
      done = await add(c);
    } else if (c.kind === "edit") {
      done = await edit(c);
    } else {
      done = await finish({ ...c, kind: c.kind });
    }
  } catch (e) {
    result = "failed";
    done = {
      after: fieldsOf(c),
      error: (e as Error).message,
      target: `reminder:${c.target ?? "new"}`,
    };
  }
  const action: Action = {
    ...done,
    at: clock().toISOString(),
    id,
    instruction,
    kind: c.kind,
    madeBy: a.madeBy,
    result,
    schemaVersion: 1,
    why: a.why,
  };
  await appendJsonl(ACTIONS, Action, [action]);
  if (result === "failed") {
    await sendReport(`action/${id}`, actionFailedReport(action));
  }
  return action;
}

/** The instruction of a request a client makes, not his recorded speech: his words, the time now, and a ref of its own, so each request acts. */
export const requested = (
  madeBy: string,
  quote: string,
  at = clock().toISOString()
) => ({ at, quote, ref: `${madeBy}:${at}` });

/** `act` for a request that comes from a client (`requested`). */
export function actAsked(
  { said, why, ...change }: Asked,
  madeBy: "connector" | "session"
) {
  return act({ change, instruction: requested(madeBy, said), madeBy, why });
}

/** The most reminders the grant adds in one of his days. */
const GRANT_DAILY = 3;

/** A reminder the standing grant added: an add whose instruction is an observation, not his words in a request. */
const isGranted = (a: Action) =>
  a.kind === "add" && Boolean(a.instruction?.ref.startsWith("obs_"));

/** The grant's earlier add from this observation, if one stands: the same observation adds once. */
export const grantedFrom = (actions: Action[], obs: string) =>
  actions.find(
    (a) => isGranted(a) && a.instruction?.ref === obs && a.result !== "failed"
  );

/**
 * Why the standing grant (his yes, decision 2 of the 21 Oct review) may not add a reminder from this observation, or
 * nothing when it may. All of it derived from the ledger: it is off until his words in a Claude session turn it on
 * (`setGrant`, the latest such line standing), and off again once a reminder it added was removed after that (his undo),
 * it adds at most GRANT_DAILY a day (his local day), only from his current salience-3 to-do or promise in a lifelog
 * turn the store credits to him now (`mine`); a shared list is `unshared`'s, checked last (it reads his Reminders).
 */
export function grantRefusal(g: {
  actions: Action[];
  mine: boolean;
  now: string;
  o: Pick<Observation, "salience" | "source" | "type">;
  state: string;
}) {
  const on = g.actions.findLast((a) => a.kind === "grant");
  if (!on?.after.on) {
    return "the grant is off: only his own words in a conversation turn it on";
  }
  const made = g.actions.filter((a) => isGranted(a) && a.result === "ok");
  // The grant's reminders, followed through moves to another list (a move gives a new id), in ledger order.
  const targets = new Set<string>();
  for (const a of g.actions.filter((x) => x.result === "ok")) {
    if (
      isGranted(a) ||
      (a.kind === "edit" && targets.has(`reminder:${a.before?.id}`))
    ) {
      targets.add(a.target);
    } else if (a.kind === "remove" && targets.has(a.target) && a.at >= on.at) {
      return "the grant is off: he undid one of its reminders";
    }
  }
  if (g.state !== "active") {
    return `the observation is ${g.state}, not current`;
  }
  if (g.o.salience !== 3 || !["todo", "promise"].includes(g.o.type)) {
    return "only his salience-3 to-dos and promises";
  }
  if (kindOf(g.o.source.channel) !== "voice" || !g.mine) {
    return "only from a turn lifelog credits to his voice";
  }
  const today = localDate(g.now);
  if (made.filter((a) => localDate(a.at) === today).length >= GRANT_DAILY) {
    return `already ${GRANT_DAILY} today`;
  }
}

/** Whether a list is plainly nobody else's: the grant never adds to a shared one (that would be a send). Fails closed. */
export const unshared = (list: { sharees?: unknown[]; shared?: boolean }) =>
  list.shared === false && list.sharees?.length === 0;

/** Turns the standing grant on (his words in a Claude session) or off (his "stop", also through Atlas: off only takes authority away), `bun life grant`: one ledger line, the latest standing. Never from the connector. */
export async function setGrant(on: boolean, said: string) {
  const instruction = requested("session", said);
  const line: Action = {
    after: { on },
    at: instruction.at,
    id: actionId(instruction.ref, "grant", `${on}`),
    instruction,
    kind: "grant",
    madeBy: "session",
    result: "ok",
    schemaVersion: 1,
    target: "grant",
    why: "his words",
  };
  await appendJsonl(ACTIONS, Action, [line]);
  return line;
}

/** What the grant may set: an add's title, list (always named: its sharing is checked), due and section, nothing else. */
export const Granted = Change.pick({
  due: true,
  list: true,
  section: true,
  title: true,
})
  .extend({ kind: z.literal("add"), list: z.string() })
  .strict();
export type Granted = z.infer<typeof Granted>;

/** One grant at a time: the cap and the dedupe read the ledger, and only `act` appends to it. */
let granting: Promise<unknown> = Promise.resolve();

/**
 * The standing grant's add (the connector's `reminders` with `obs`), from the observation as `claim` reads it: the
 * instruction is the observation itself (its id, his quote, when he said it), never words a client passes, and the
 * turn's credit and the list's sharing are re-read now. It binds the connector only, not what Atlas does in its terminal.
 */
export function actGranted(
  {
    observation: o,
    status,
  }: { observation: Observation; status: { state: string } },
  change: Granted
) {
  const run = granting.then(async () => {
    const actions = await readActions();
    const old = grantedFrom(actions, o.id);
    if (old) {
      return old;
    }
    const no = grantRefusal({
      actions,
      // A chat or mail ref is no turn: never his voice.
      mine: await withStore((s) => ownerSpoke(s, o.source.ref)),
      now: clock().toISOString(),
      o,
      state: status.state,
    });
    if (no) {
      throw new Error(`Not done: ${no}.`);
    }
    // His Reminders are read only once everything else allows it.
    const list = await remctl<{ sharees?: unknown[]; shared?: boolean }>([
      "list-info",
      "--",
      change.list,
    ]);
    if (!unshared(list)) {
      throw new Error("Not done: the list is shared: that needs his words.");
    }
    return act({
      change,
      instruction: { at: o.at, quote: o.quote, ref: o.id },
      madeBy: "connector",
      why: "the standing grant: his own spoken to-do",
    });
  });
  granting = run.catch(() => undefined);
  return run;
}

/** A reminder as remctl's `show` gives it (`--completed`: ticked ones too). */
export interface Reminder {
  allDay?: boolean;
  completed: boolean;
  dueDate?: string;
  id: number;
  list?: string;
  notes?: string;
  section?: string;
  title: string;
}

/** An open reminder as `open_reminders` promises it: `due` as a change takes it, notes whole (an edit replaces them). */
export const openOf = (r: Reminder) => ({
  due:
    r.dueDate &&
    (r.allDay
      ? r.dueDate.slice(0, 10)
      : r.dueDate.slice(0, 16).replace("T", " ")),
  id: r.id,
  list: r.list,
  notes: r.notes,
  section: r.section,
  title: r.title,
});

/** The lists read for his reminders: one or all, never the board (its tasks are read with `tasks`). */
export const readable = (title: string, list?: string) =>
  title !== BOARD && (list === undefined || title === list);

/** His lists read for both reads below: `readable` ones, not groups. */
async function listsOf(list?: string) {
  const lists = await remctl<{ id: number; isGroup: boolean; title: string }[]>(
    ["lists"]
  );
  return lists.filter((l) => !l.isGroup && readable(l.title, list));
}

/** Every open top-level reminder, of one list or all, never the board: what an add's title is checked against, and the connector's `open_reminders`. */
export async function openReminders(list?: string) {
  const open = await Promise.all(
    (await listsOf(list)).map((l) =>
      remctl<Reminder[]>(["show", "--list-id", `${l.id}`])
    )
  );
  return open.flat();
}

/** Each of those lists' sections by its name, empty ones too, from one call: `open_reminders`'s. */
export async function sectionsOf(list?: string) {
  const [lists, all] = await Promise.all([
    listsOf(list),
    remctl<Record<string, string[]>>(["sections"]),
  ]);
  return Object.fromEntries(lists.map((l) => [l.title, all[l.title] ?? []]));
}

/**
 * Whether remctl can act right now (read-only: nothing is written). The problems, none when it is ready. One read
 * through the signed host, not `remctl doctor` (its Tailscale probe times out while Reminders are fine); a broken
 * private helper (sections, subtasks) shows as a partial on an act (in the nightly's
 * Actions); on the board only in the log.
 */
export async function checks() {
  try {
    await remctl(["lists"]);
    return [];
  } catch (e) {
    return [`Reminders: ${(e as Error).message}`];
  }
}
