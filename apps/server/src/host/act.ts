import { z } from "zod";
import {
  BOARD,
  backend,
  type Done,
  info,
  intended,
  lacks,
  write,
} from "../actions/backend";
import { Change } from "../actions/contract";
import { linked, openLinked } from "../actions/items";
import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import { ACTIONS, digest, readActions } from "../memory/ledger";
import { normalize } from "../memory/units";
import { localDate } from "../memory/zones";
import { Action, type Instruction, stands } from "../records/ledger";
import type { Observation } from "../records/observations";
import { kindOf } from "../sources";
import { ownerSpoke, withStore } from "../sources/lifelog";
import { actionFailedReport, sendReport } from "./report";

// What Life does outside itself on the owner's clear request: each change to his items in the actions backend (Apple
// Reminders or Google Tasks, `backend.ts`) is one `act`, which decides it, has `write` make it, records it as an Action
// (memory/actions.jsonl) and tells him by email when it failed. Nothing here reads his words: the callers (the CLI, the
// connector) decide that he asked. The ledger also holds the agent's tasks (apps/server/src/host/tasks.ts), whose board, the list `BOARD`,
// no `act` may touch.

export const actionId = (ref: string, kind: string, title: string) =>
  `act_${digest("sha1", `${ref}|${kind}|${normalize(title)}`, 12)}`;

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

/** The open item an add would repeat (the same title), so nothing is written: the one duplicate check, for every caller. Its target. */
export function duplicateOf(
  c: Change,
  open: { target: string; title: string }[]
) {
  return c.kind === "add"
    ? open.find((r) => normalize(r.title) === normalize(c.title))?.target
    : undefined;
}

/** The record of an action already done (or asked) with this id: the same words act once, unless that try failed (or never ended). */
export const recorded = async (id: string) =>
  (await readActions()).find((x) => x.id === id && stands(x));

/**
 * Does one change and records it in memory/actions.jsonl; a failure is recorded too, and emailed at once with his words
 * so he can do it by hand. The same words asking for the same thing act once (the old record comes back), unless that
 * try failed: then they try again.
 */
export async function act(a: Act): Promise<Action> {
  const { change: c, instruction } = a;
  // Refused before anything is recorded; a target it cannot read fails as usual, below.
  const b = backend();
  const no = lacks(c, b);
  if (no.length > 0) {
    throw new Error(`${b.label} cannot do this (no ${no.join(", ")})`);
  }
  if (c.kind === "restore" && !(c.target && c.list)) {
    throw new Error(
      "a restore needs the reminder id and the list to put it in"
    );
  }
  const on = c.target && (await info(c.target).catch(() => undefined))?.list;
  if (c.list === BOARD || on === BOARD) {
    throw new Error(`the list ${BOARD} is the agent's board: use \`task\``);
  }
  const id = actionId(instruction.ref, c.kind, c.title);
  const old = await recorded(id);
  if (old) {
    return old;
  }
  // Read from the ledger (apps/server/src/actions/items.ts), never from Reminders: his hand-made ones are there once sync read them.
  const open =
    c.kind === "add"
      ? openLinked(await readActions(), b.prefix).map((it) => ({
          target: it.target,
          title: String(it.fields.title ?? ""),
        }))
      : [];
  const same = duplicateOf(c, open);
  const ref = (item: string | number) => `${b.prefix}:${item}`;
  const line = (done: Done, result: Action["result"]): Action => ({
    ...done,
    at: clock().toISOString(),
    id,
    instruction,
    kind: c.kind,
    madeBy: a.madeBy,
    result,
    schemaVersion: 1,
    why: a.why,
  });
  const tried = { after: intended(c), target: ref(c.target ?? "new") };
  let action: Action;
  if (same) {
    action = line({ after: { title: c.title }, target: same }, "duplicate");
  } else {
    // Recorded before the write: whatever happens next, Reminders showing this value is Life's doing, never his (#69).
    await appendJsonl(ACTIONS, Action, [line(tried, "intent")]);
    try {
      action = line(await write(c), "ok");
    } catch (e) {
      action = line({ ...tried, error: (e as Error).message }, "failed");
    }
  }
  await appendJsonl(ACTIONS, Action, [action]);
  if (action.result === "failed") {
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
  actions.find((a) => isGranted(a) && a.instruction?.ref === obs && stands(a));

/**
 * Why the standing grant (his yes, decision 2 of the 21 Oct review) may not add a reminder from this observation, or
 * nothing when it may. All of it derived from the ledger: it is off until his words in a Claude session turn it on
 * (`setGrant`, the latest such line standing), and off again once a reminder it added was removed after that (his undo),
 * it adds at most GRANT_DAILY a day (his local day), only from his current salience-3 to-do or promise in a lifelog
 * turn the store credits to him now (`mine`); a shared list is the backend's `shared`, checked last (it reads his lists).
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
  // The grant's reminders as the ledger follows them (through moves, his removals in Reminders too).
  const keys = new Set(made.map((a) => a.id));
  const undone = [...linked(g.actions).values()].some(
    (it) => keys.has(it.key) && (it.removedAt ?? "") >= on.at
  );
  if (undone) {
    return "the grant is off: he undid one of its reminders";
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

/** Turns the standing grant on (his words in a Claude session) or off (his "stop", also through the agent: off only takes authority away), `bun life grant`: one ledger line, the latest standing. Never from the connector. */
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
 * turn's credit and the list's sharing are re-read now. It binds the connector only, not what the agent does in its terminal.
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
    if (await backend().shared(change.list)) {
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
