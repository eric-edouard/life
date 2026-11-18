import { clock } from "../core/clock";
import { log } from "../core/log";
import { DESK_AGENT } from "../core/names";
import {
  type AgentRow,
  activeAgents,
  agentOf,
  type EventRow,
  filtersOf,
  lastTurns,
  modelOf,
  openTurn,
  queuedEvents,
  readCursor,
  type TurnRow,
} from "../host/desk-read";
import {
  MESSAGE_RECEIVED,
  matcherOf,
  pollDecisions,
  readMessageEvents,
} from "../host/events";
import { MAX_PAGE } from "../memory/changes";
import { decisionsNow } from "../memory/decisions";
import { readPeople } from "../memory/who";
import type { TurnOutcome } from "../records/registered-agent";
import { readPacket } from "./agent-actions";
import { applyAgentChanges } from "./agent-changes";
import {
  ANSWERS,
  defaultWaitOf,
  dueOf,
  failuresOf,
  GROWTH_LIMIT,
  MAX_HANDED,
  STARTS_PER_TICK,
} from "./agent-wait";
import { doorOf } from "./desk-door";
import { type Desk, saveCursor, writeWait } from "./desk-store";
import type { Run, Agent as SessionAgent, Usage } from "./runtimes/contract";

// The desk's clock (the desk spec, sections 6 and 7): one tick polls his answers and the messages its agents wait for
// into their queues, then starts the turns that are due; each turn ends when its run does (`Run.ended`). Everything is
// read from the store each time, so a sleep or a restart loses nothing.

const REMINDER =
  "Before you stop, call `set_wait` (what you wait for, until when) or `finish`.";

const now = () => clock().toISOString();

/**
 * Reads the new messages once and queues each for every active agent waiting for it, in the transaction that saves
 * the cursor (its name, `message.received`): delivered at least once, never twice (an event id is kept once per
 * agent). With no agent active, nothing is read, and the next read starts at that time.
 */
export async function pollMessages({ db, sources }: Desk) {
  const agents = activeAgents(db);
  if (agents.length === 0) {
    saveCursor(db, MESSAGE_RECEIVED, null);
    return;
  }
  const people = await readPeople();
  const matchers = agents.flatMap((a) =>
    filtersOf(a).flatMap((f) => {
      const isMatch = matcherOf(f, people);
      return isMatch ? [{ id: a.id, isMatch }] : [];
    })
  );
  const read = readMessageEvents(
    readCursor(db, MESSAGE_RECEIVED),
    MAX_PAGE,
    people,
    (m, e) => {
      const ids = new Set(
        matchers.filter((x) => x.isMatch(m, e)).map((x) => x.id)
      );
      return ids.size ? { ids, m } : null;
    },
    sources
  );
  db.transaction(() => {
    for (const { ids, m } of read.items) {
      for (const id of ids) {
        db.run(
          "insert or ignore into event (agent_id, event_id, name, payload, received_at) values (?, ?, ?, ?, ?)",
          [id, m.id, MESSAGE_RECEIVED, JSON.stringify(m), now()]
        );
      }
    }
    saveCursor(db, MESSAGE_RECEIVED, read.cursor);
  })();
}

/**
 * Queues his answers to the agents' decisions, and their lapses, for the active agent that asked each, in the
 * transaction that saves each cursor: read through `pollDecisions`, as the desk (every registered agent asks as it).
 */
export function pollAnswers({ db }: Desk) {
  const active = new Set(activeAgents(db).map((a) => a.id));
  const reads = ANSWERS.map((name) => ({
    name,
    read: pollDecisions(name, readCursor(db, name), DESK_AGENT),
  }));
  // Read after the polls, so every decision they return is known.
  const askedBy = new Map(decisionsNow().map((d) => [d.id, d.agent]));
  for (const { name, read } of reads) {
    db.transaction(() => {
      for (const e of read.events) {
        const id = askedBy.get(e.data.id);
        if (id && active.has(id)) {
          db.run(
            "insert or ignore into event (agent_id, event_id, name, payload, received_at) values (?, ?, ?, ?, ?)",
            [id, e.eventId, name, JSON.stringify(e.data), now()]
          );
        }
      }
      saveCursor(db, name, read.cursor);
    })();
  }
}

/** The message that wakes a session: why, and each queued event's facts (who, where, when, the id to read). */
const wakeMessageOf = (cause: string, events: EventRow[]) =>
  [
    `Woken by the desk: ${cause}.`,
    ...events.map((e) => `${e.name} ${e.payload}`),
  ].join("\n");

/** What a session of `a` is given: its door, its folder, a title, the model it runs with. */
const sessionAgentOf = (a: AgentRow): SessionAgent => ({
  ...modelOf(a),
  door: doorOf(a.id),
  folder: a.folder,
  id: a.id,
  title: a.brief.slice(0, 60),
});

/** The turns whose run this process watches end (`Run.ended`): any other open turn was started before a restart. */
const watched = new WeakMap<Desk["db"], Set<number>>();
function watchedIn(db: Desk["db"]) {
  const turns = watched.get(db) ?? new Set<number>();
  watched.set(db, turns);
  return turns;
}

/** Ends turn `turn` of `id` when `run` does: failed when it did. */
function watch(desk: Desk, id: string, turn: number, run: Run) {
  watchedIn(desk.db).add(turn);
  run.ended
    .then(({ ok }) => turnEnded(desk, id, !ok))
    .catch((error: unknown) =>
      log("desk.runtime", {
        agent: id,
        error: String(error),
        ok: false,
        what: "end",
      })
    );
}

/**
 * Starts a turn for `a`, or leaves a session running a turn of his alone (false: the wake comes after it). The turn is
 * written and its queued events handed before the runtime is called, so the turn's end, however soon, finds it. It
 * runs into its session while that has grown under 30,000 tokens, else in a fresh session from its packet (the old
 * one's link kept). A runtime that fails ends it failed, tried again later.
 */
async function wake(desk: Desk, a: AgentRow, cause: string) {
  const { db } = desk;
  const runtime = desk.runtimes[a.runtime];
  // null: the runtime can't say; the send then tells.
  const state =
    a.session && runtime
      ? await runtime.state(a.session).catch(() => null)
      : "gone";
  if (state === "running") {
    return false;
  }
  const events = queuedEvents(db, a.id);
  const turn = Number(
    db.transaction(() => {
      for (const e of events) {
        db.run(
          "update event set handed = handed + 1 where agent_id = ? and event_id = ?",
          [a.id, e.event_id]
        );
      }
      return db.run(
        "insert into turn (agent_id, session, cause, started_at) values (?, ?, ?, ?)",
        [a.id, a.session, cause, now()]
      ).lastInsertRowid;
    })()
  );
  try {
    if (!runtime) {
      throw new Error(`no runtime ${a.runtime}`);
    }
    const grown =
      a.session && state === "idle"
        ? ((await runtime.usage(a.session))?.grownBy ?? 0)
        : 0;
    if (!a.session || state === "gone" || grown >= GROWTH_LIMIT) {
      const s = await runtime.start(sessionAgentOf(a), readPacket(desk, a.id));
      db.transaction(() => {
        db.run(
          "update session set ended_at = ?, why_ended = 'fresh' where agent_id = ? and ended_at is null",
          [now(), a.id]
        );
        db.run(
          "insert into session (agent_id, runtime, ref, link, started_at) values (?, ?, ?, ?, ?)",
          [a.id, a.runtime, s.ref, s.link, now()]
        );
        db.run("update agent set session = ?, link = ? where id = ?", [
          s.ref,
          s.link,
          a.id,
        ]);
        db.run("update turn set session = ? where id = ?", [s.ref, turn]);
      })();
      watch(desk, a.id, turn, s);
    } else {
      watch(
        desk,
        a.id,
        turn,
        await runtime.send(
          sessionAgentOf(a),
          a.session,
          wakeMessageOf(cause, events)
        )
      );
    }
  } catch (error) {
    log("desk.runtime", {
      agent: a.id,
      error: String(error),
      ok: false,
      what: "wake",
    });
    await turnEnded(desk, a.id, true);
  }
  return true;
}

/**
 * Starts the turns due now: his answers first, then the oldest deadline, until 3 have started this tick (an agent
 * whose session runs a turn of his takes no place).
 */
export async function wakeDue(desk: Desk) {
  const t = clock().getTime();
  const due = activeAgents(desk.db)
    .flatMap((a) => {
      const d = dueOf(a, lastTurns(desk.db, a.id), queuedEvents(desk.db, a.id));
      return d && d.at <= t ? [{ a, ...d }] : [];
    })
    .toSorted(
      (x, y) =>
        Number(y.cause === "answer") - Number(x.cause === "answer") ||
        x.at - y.at
    );
  let started = 0;
  for (const d of due) {
    if (started === STARTS_PER_TICK) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: whether one started decides whether the next may
    started += (await wake(desk, d.a, d.cause)) ? 1 : 0;
  }
}

/**
 * One tick of the clock: his word about his agents, his answers, then (when their poll is due) the messages and the turns lost to a restart, then
 * the turns due.
 */
export async function tick(desk: Desk, isPollDue = true) {
  await applyAgentChanges(desk);
  pollAnswers(desk);
  if (isPollDue) {
    await pollMessages(desk);
    await endLostTurns(desk);
  }
  await wakeDue(desk);
}

/**
 * Ends a turn, once (a turn already ended is left as it is): its handed events consumed when it waited or finished,
 * else handed again later, and dropped once handed `MAX_HANDED` times.
 */
function close(
  desk: Desk,
  t: TurnRow,
  outcome: TurnOutcome,
  usage: Usage | null
) {
  const { db } = desk;
  watchedIn(db).delete(t.id);
  const ended = db.run(
    "update turn set ended_at = ?, outcome = ?, tokens_in = ?, tokens_cached = ?, tokens_out = ? where id = ? and ended_at is null",
    [
      now(),
      outcome,
      usage?.tokensIn ?? null,
      usage?.tokensCached ?? null,
      usage?.tokensOut ?? null,
      t.id,
    ]
  ).changes;
  if (ended === 0) {
    return false;
  }
  db.run(
    outcome === "waited" || outcome === "finished"
      ? "update event set consumed_at = ? where agent_id = ? and handed > 0 and consumed_at is null and dropped_at is null"
      : `update event set dropped_at = ? where agent_id = ? and handed >= ${MAX_HANDED} and consumed_at is null and dropped_at is null`,
    [now(), t.agent_id]
  );
  return true;
}

/** After a failed turn: once the retries are spent, the default wait stands. */
function afterFailure({ db }: Desk, a: AgentRow) {
  if (a.status === "active" && failuresOf(lastTurns(db, a.id)) >= MAX_HANDED) {
    writeWait(db, a.id, defaultWaitOf(a, clock().getTime()), true);
  }
}

/**
 * The run of `id`'s open desk turn ended (`failed` when it did). A turn ends by `set_wait` or `finish`; with neither,
 * the desk reminds it once, then sets the default wait. The turn's tokens are read from its runtime.
 */
export async function turnEnded(desk: Desk, id: string, failed = false) {
  const { db } = desk;
  const t = openTurn(db, id);
  const a = agentOf(db, id);
  const runtime = a && desk.runtimes[a.runtime];
  if (!(t && a)) {
    return;
  }
  const usage =
    t.session && runtime
      ? await runtime.usage(t.session).catch(() => null)
      : null;
  if (failed) {
    db.transaction(() => {
      if (close(desk, t, "failed", usage)) {
        afterFailure(desk, a);
      }
    })();
    return;
  }
  if (t.outcome === "waited" || t.outcome === "finished") {
    close(desk, t, t.outcome, usage);
    return;
  }
  if (!t.reminded_at && a.session && runtime) {
    // Marked before it is sent, so a turn ending at once is never reminded twice.
    db.run("update turn set reminded_at = ? where id = ?", [now(), t.id]);
    try {
      watch(
        desk,
        id,
        t.id,
        await runtime.send(sessionAgentOf(a), a.session, REMINDER)
      );
      return;
    } catch (error) {
      log("desk.runtime", {
        agent: id,
        error: String(error),
        ok: false,
        what: "remind",
      });
    }
  }
  db.transaction(() => {
    if (close(desk, t, "default_wait", usage) && a.status === "active") {
      writeWait(db, id, defaultWaitOf(a, clock().getTime()), true);
    }
  })();
}

/**
 * Ends the desk turns this process does not watch and whose runtime runs nothing now (started before the helper or the
 * Mac stopped): by its outcome when it set a wait or finished, else failed and retried.
 */
export async function endLostTurns(desk: Desk) {
  const watching = watchedIn(desk.db);
  await Promise.all(
    activeAgents(desk.db).map(async (a) => {
      const t = openTurn(desk.db, a.id);
      const runtime = desk.runtimes[a.runtime];
      if (
        t &&
        !watching.has(t.id) &&
        (!(t.session && runtime) ||
          (await runtime.state(t.session).catch(() => "running")) !== "running")
      ) {
        await turnEnded(desk, a.id, !t.outcome);
      }
    })
  );
}
