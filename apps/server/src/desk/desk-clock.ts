import { existsSync } from "node:fs";
import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { DESK_AGENT } from "../core/names";
import { isOwnLife } from "../core/platform";
import {
  type AgentRow,
  activeAgents,
  agentOf,
  type EventRow,
  eventHeard,
  filtersOf,
  lastTurns,
  modelOf,
  openTurn,
  queuedEvents,
  readCursor,
  type TurnRow,
} from "../host/desk-read";
import {
  CALL_ENDED,
  callMatcherOf,
  MESSAGE_RECEIVED,
  matcherOf,
  pollDecisions,
  readEndedCalls,
  readMessageEvents,
} from "../host/events";
import { MAX_PAGE } from "../memory/changes";
import { decisionsNow } from "../memory/decisions";
import { type People, readPeople } from "../memory/who";
import type { TurnOutcome } from "../records/registered-agent";
import { readStore, storeFiles, WATCH, withStore } from "../sources/lifelog";
import { recordingsOf } from "../sources/lifelog-speech";
import { finish, readPacket } from "./agent-actions";
import { applyAgentChanges, handOverReplaced } from "./agent-changes";
import {
  ANSWERS,
  BEGIN_WITHIN_MS,
  defaultWaitOf,
  dueOf,
  eventLineOf,
  failuresOf,
  GROWTH_LIMIT,
  growthOf,
  isBeginLate,
  MAX_HANDED,
  STARTS_PER_TICK,
} from "./agent-wait";
import { doorOf } from "./desk-door";
import { type Desk, saveCursor, writeWait } from "./desk-store";
import {
  MATTER_RELATED,
  netsOf,
  relatedMessages,
  relatedRecordings,
} from "./matter-net";
import type {
  Run,
  RunEnd,
  Runtime,
  Agent as SessionAgent,
  Usage,
} from "./runtimes/contract";

// The desk's clock (the desk spec, sections 6 and 7): one tick polls his answers and the messages its agents wait for
// into their queues, then starts the turns that are due; each turn ends when its run does (`Run.ended`). Everything is
// read from the store each time, so a sleep or a restart loses nothing.

const REMINDER =
  "Before you stop, call `set_wait` (what you wait for, until when) or `finish`.";

const now = () => clock().toISOString();

/** Who his people are, read when a poll first needs them: once per poll (`readPeopleOnce`). */
type ReadPeople = () => Promise<People>;

/** `readPeople`, read at most once however often it is asked. */
export function readPeopleOnce(): ReadPeople {
  let read: Promise<People> | undefined;
  return () => {
    read ??= readPeople();
    return read;
  };
}

/** Queues `wakes` (one event each, kept once per agent and id) as `name`. */
function queue(
  db: Desk["db"],
  name: string,
  wakes: { agent: string; eventId: string; payload: unknown }[]
) {
  for (const w of wakes) {
    db.run(
      "insert or ignore into event (agent_id, event_id, name, payload, received_at) values (?, ?, ?, ?, ?)",
      [w.agent, w.eventId, name, JSON.stringify(w.payload), now()]
    );
  }
}

/**
 * Reads the new messages once and queues each for every active agent waiting for it, then for every agent on a matter
 * it relates to (`relatedMessages`, `matter.related`: a message its wait already queued is not queued again), in the
 * transaction that saves the cursor (its name, `message.received`): delivered at least once, never twice (an event id
 * is kept once per agent). With no agent active, nothing is read, and the next read starts at that time.
 */
export async function pollMessages(desk: Desk, readPeopleNow: ReadPeople) {
  const { db, sources } = desk;
  const agents = activeAgents(db);
  if (agents.length === 0) {
    saveCursor(db, MESSAGE_RECEIVED, null);
    return;
  }
  const people = await readPeopleNow();
  const nets = await netsOf(desk, people);
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
      return ids.size || nets.length
        ? { fromMe: e.fromMe, ids, m, text: e.text }
        : null;
    },
    sources
  );
  const related = await relatedMessages(desk, nets, read.items);
  db.transaction(() => {
    queue(
      db,
      MESSAGE_RECEIVED,
      read.items.flatMap(({ ids, m }) =>
        [...ids].map((agent) => ({ agent, eventId: m.id, payload: m }))
      )
    );
    queue(db, MATTER_RELATED, related);
    saveCursor(db, MESSAGE_RECEIVED, read.cursor);
  })();
}

/**
 * Queues `call.ended` for each active agent whose wait wants a call that ended in the last 12 hours (`readEndedCalls`),
 * once lifelog holds the call's words (`recordingsOf`): the chat, the span, who was on it and where its turns are, never
 * a word. A call with no turn inside (the pendant was off) queues nothing and is looked at again next poll until it is
 * 12 hours old; one already queued for an agent is not looked at (`eventHeard`), and the queue keeps it once per agent
 * and call, so no cursor is kept. `at` is the time the polls look back from, passed so a replay can set the evening.
 */
export async function pollCalls(
  desk: Desk,
  readPeopleNow: ReadPeople,
  at = clock().getTime(),
  watchDir = WATCH
) {
  const { db } = desk;
  const agents = activeAgents(db);
  if (agents.length === 0 || !existsSync(storeFiles(watchDir).file)) {
    return;
  }
  const people = await readPeopleNow();
  const calls = readEndedCalls(people, desk.sources, at);
  const wakes = agents.flatMap((a) => {
    const matchers = filtersOf(a).flatMap(
      (f) => callMatcherOf(f, people) ?? []
    );
    return calls.flatMap((call) =>
      call.until >= a.created_at &&
      matchers.some((isMatch) => isMatch(call)) &&
      eventHeard(db, a.id, `${call.id}.ended`) === "not_yet"
        ? [{ agent: a.id, call }]
        : []
    );
  });
  if (wakes.length === 0) {
    return;
  }
  try {
    const recordings = await withStore(
      (store) =>
        new Map(
          wakes.map(({ call }) => [
            call.id,
            recordingsOf(store, call.at, call.until),
          ])
        ),
      () => readStore(watchDir)
    );
    db.transaction(() =>
      queue(
        db,
        CALL_ENDED,
        wakes.flatMap(({ agent, call }) => {
          const found = recordings.get(call.id);
          return found
            ? [
                {
                  agent,
                  eventId: `${call.id}.ended`,
                  payload: { ...call, recordings: found },
                },
              ]
            : [];
        })
      )
    )();
  } catch (error) {
    log("desk.runtime", { error: String(error), ok: false, what: "calls" });
  }
}

/** Queues his pendant's new recordings for every agent on a matter they relate to (`relatedRecordings`). */
export async function pollRecordings(desk: Desk, readPeopleNow: ReadPeople) {
  if (activeAgents(desk.db).length === 0) {
    return;
  }
  const people = await readPeopleNow();
  const wakes = await relatedRecordings(
    desk,
    await netsOf(desk, people),
    people
  );
  desk.db.transaction(() => queue(desk.db, MATTER_RELATED, wakes))();
}

/** Ends each active agent whose matter is done (`netsOf`'s read of the matters): nothing is left for it to do or wait for. */
export async function endAgentsOnDoneMatters(
  desk: Desk,
  readPeopleNow: ReadPeople
) {
  if (activeAgents(desk.db).length === 0) {
    return;
  }
  const nets = await netsOf(desk, await readPeopleNow());
  for (const n of nets.filter((x) => x.isDone)) {
    // biome-ignore lint/performance/noAwaitInLoops: one agent's decision withdrawn at a time
    await finish(desk, n.agent, "its matter is done");
  }
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
      queue(
        db,
        name,
        read.events.flatMap((e) => {
          const agent = askedBy.get(e.data.id);
          return agent && active.has(agent)
            ? [{ agent, eventId: e.eventId, payload: e.data }]
            : [];
        })
      );
      saveCursor(db, name, read.cursor);
    })();
  }
}

/** The message that wakes a session: why, for a deadline wake since when to sweep (`since`: when its last turn ended), and each queued event's facts (who, where, when, the id to read). */
const wakeMessageOf = (cause: string, events: EventRow[], since?: string) =>
  [
    `Woken by the desk: ${cause}.`,
    ...(since
      ? [
          `Nothing you waited for arrived since your last turn ended, at ${since}: sweep what happened since then on your subject (\`read_memory_changes\` with \`since\`, \`read_matters\`, \`read_chats\`).`,
        ]
      : []),
    ...events.map(eventLineOf),
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

/** Marks turn `turn` under way, once. */
const markBegun = (db: Desk["db"], turn: number) =>
  db.run("update turn set begun_at = ? where id = ? and begun_at is null", [
    now(),
    turn,
  ]);

/** Ends turn `turn` of `id` when `run` does: failed when it did. */
function watch(desk: Desk, id: string, turn: number, run: Run) {
  watchedIn(desk.db).add(turn);
  // A run that ends before it begins is `ended`'s to say; `begun` settles soon after `ended` at the latest, and is waited
  // for, so a turn that began and then failed is retried, never ended as not started.
  const begun = run.begun.then(
    () => markBegun(desk.db, turn),
    () => undefined
  );
  run.ended
    .then(async (end) => {
      await begun;
      return turnEnded(desk, id, end);
    })
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
async function wake(desk: Desk, a: AgentRow) {
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
  // Read again as its turn is written: since the tick listed it, the agent may have finished, set a later wait or been
  // woken (a runtime's start can take 30 s).
  const woken = db.transaction(() => {
    const fresh = agentOf(db, a.id);
    const events = queuedEvents(db, a.id);
    const due =
      fresh?.status === "active"
        ? dueOf(fresh, lastTurns(db, a.id), events)
        : null;
    if (!(fresh && due) || due.at > clock().getTime()) {
      return null;
    }
    for (const e of events) {
      db.run(
        "update event set handed = handed + 1 where agent_id = ? and event_id = ?",
        [a.id, e.event_id]
      );
    }
    const id = db.run(
      "insert into turn (agent_id, session, cause, started_at) values (?, ?, ?, ?)",
      [a.id, fresh.session, due.cause, now()]
    ).lastInsertRowid;
    return { a: fresh, cause: due.cause, events, turn: Number(id) };
  })();
  if (!woken) {
    return false;
  }
  await launch(desk, woken, state);
  return true;
}

/** Launches turn `turn` of `a` in its runtime, as `wake` wrote it; a launch that fails ends the turn failed. */
async function launch(
  desk: Desk,
  {
    a,
    cause,
    events,
    turn,
  }: { a: AgentRow; cause: string; events: EventRow[]; turn: number },
  state: "running" | "idle" | "gone" | null
) {
  const { db } = desk;
  const runtime = desk.runtimes[a.runtime];
  try {
    if (!runtime) {
      throw new Error(`no runtime ${a.runtime}`);
    }
    const grown = a.session && state === "idle" ? readGrowth(db, a.session) : 0;
    if (!a.session || state === "gone" || grown >= GROWTH_LIMIT) {
      const s = await runtime.start(
        sessionAgentOf(a),
        await readPacket(desk, a.id, isOwnLife())
      );
      // Watched first: its process runs, so a failed write below never ends it as not started.
      watch(desk, a.id, turn, s);
      try {
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
      } catch (error) {
        log("desk.runtime", {
          agent: a.id,
          error: String(error),
          ok: false,
          what: "session",
        });
      }
    } else {
      watch(
        desk,
        a.id,
        turn,
        await runtime.send(
          sessionAgentOf(a),
          a.session,
          wakeMessageOf(
            cause,
            events,
            cause === "deadline"
              ? (lastTurns(db, a.id).find((t) => t.id < turn && t.ended_at)
                  ?.ended_at ?? undefined)
              : undefined
          )
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
    await turnEnded(desk, a.id, { ok: false, why: (error as Error).message });
  }
}

/** How much session `ref` has grown (`growthOf`), from what its turns kept. */
const readGrowth = (db: Desk["db"], ref: string) =>
  growthOf(
    db
      .query<{ context_at_first_call: number | null }, [string]>(
        "select context_at_first_call from session where ref = ?"
      )
      .get(ref),
    db
      .query<{ context_used: number | null }, [string]>(
        "select context_used from turn where session = ? and context_used is not null order by id desc limit 1"
      )
      .all(ref)
  );

/**
 * Starts the turns due now: his answers and new agents' first turns first, then the oldest deadline, until 3 have
 * started this tick (an agent whose session runs a turn of his takes no place). Each is read again as its turn is written.
 */
export async function wakeDue(desk: Desk) {
  const t = clock().getTime();
  const due = activeAgents(desk.db)
    .flatMap((a) => {
      const turns = lastTurns(desk.db, a.id);
      const d = dueOf(a, turns, queuedEvents(desk.db, a.id));
      return d && d.at <= t
        ? [
            {
              a,
              at: d.at,
              isAtOnce: d.cause === "answer" || turns.length === 0,
            },
          ]
        : [];
    })
    .toSorted((x, y) => Number(y.isAtOnce) - Number(x.isAtOnce) || x.at - y.at);
  let started = 0;
  for (const d of due) {
    if (started === STARTS_PER_TICK) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: whether one started decides whether the next may
    started += (await wake(desk, d.a)) ? 1 : 0;
  }
}

/**
 * One tick of the clock: his word about his agents, his answers, the turns that never began, then the turns due (a new
 * agent's first turn never waits behind the polls), then, when their poll is due, the messages, the calls that ended, the recordings, the
 * agents whose matter is done and the turns lost to a restart (what they queue is woken next tick). The calls come after the messages, so a chat's messages and its call that ended are one burst.
 */
export async function tick(desk: Desk, isPollDue = true) {
  await applyAgentChanges(desk);
  handOverReplaced(desk);
  pollAnswers(desk);
  await endUnbegunTurns(desk);
  await wakeDue(desk);
  if (isPollDue) {
    const people = readPeopleOnce();
    await pollMessages(desk, people);
    await pollCalls(desk, people);
    await pollRecordings(desk, people);
    await endAgentsOnDoneMatters(desk, people);
    await endLostTurns(desk);
  }
}

/**
 * Ends a turn, once (a turn already ended is left as it is): its handed events consumed when it waited or finished,
 * else handed again later, and dropped once handed `MAX_HANDED` times.
 */
function close(
  desk: Desk,
  t: TurnRow,
  outcome: TurnOutcome,
  usage: Usage | undefined
) {
  const { db } = desk;
  watchedIn(db).delete(t.id);
  const ended = db.run(
    "update turn set ended_at = ?, outcome = ?, tokens_in = ?, tokens_cached = ?, tokens_out = ?, context_used = ? where id = ? and ended_at is null",
    [
      now(),
      outcome,
      usage?.tokensIn ?? null,
      usage?.tokensCached ?? null,
      usage?.tokensOut ?? null,
      usage?.contextLast ?? null,
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

/**
 * An agent whose first turn failed before it began is ended, not retried, with why (`why_not_started`): nothing is left
 * running, its matter is free for a new start. Its only turn is `t`, which never began.
 */
function endNotStarted({ db }: Desk, t: TurnRow, why: string) {
  if (lastTurns(db, t.agent_id, 2).length !== 1 || t.begun_at) {
    return false;
  }
  db.run(
    "update agent set status = 'ended', ended_at = ?, why_not_started = ? where id = ? and status = 'active'",
    [now(), why, t.agent_id]
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
 * the desk reminds it once, then sets the default wait. The turn's tokens are the run's own (`RunEnd.usage`).
 */
export async function turnEnded(desk: Desk, id: string, end: RunEnd) {
  const { db } = desk;
  const t = openTurn(db, id);
  const a = agentOf(db, id);
  const runtime = a && desk.runtimes[a.runtime];
  if (!(t && a)) {
    return;
  }
  const { usage } = end;
  // The session's first call, once: from the first run that reports one, whether or not that turn is reminded.
  if (typeof usage?.contextFirst === "number" && t.session) {
    db.run(
      "update session set context_at_first_call = ? where ref = ? and context_at_first_call is null",
      [usage.contextFirst, t.session]
    );
  }
  if (!end.ok) {
    db.transaction(() => {
      if (
        close(desk, t, "failed", usage) &&
        !endNotStarted(
          desk,
          t,
          end.why ?? "its first turn ended before it began"
        )
      ) {
        afterFailure(desk, a);
      }
    })();
    return;
  }
  if (t.outcome === "waited" || t.outcome === "finished") {
    close(desk, t, t.outcome, usage);
    return;
  }
  // Only an agent still active is reminded: one he stopped mid-turn gets no extra run.
  if (!t.reminded_at && a.status === "active" && a.session && runtime) {
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

/** Runs `f` on each active agent's open desk turn, with its runtime, all at once. */
const eachOpenTurn = (
  desk: Desk,
  f: (a: AgentRow, t: TurnRow, runtime: Runtime | undefined) => Promise<void>
) =>
  Promise.all(
    activeAgents(desk.db).flatMap((a) => {
      const t = openTurn(desk.db, a.id);
      return t ? [f(a, t, desk.runtimes[a.runtime])] : [];
    })
  );

/** Stops the desk's own run of session `ref` of agent `id` (`Runtime.stop`); a failure is logged. */
const stopRun = (runtime: Runtime | undefined, id: string, ref: string) =>
  runtime?.stop(ref).catch((error: unknown) =>
    log("desk.runtime", {
      agent: id,
      error: String(error),
      ok: false,
      what: "stop",
    })
  );

/**
 * Ends the desk turns this process does not watch and whose runtime runs nothing now (started before the helper or the
 * Mac stopped): by its outcome when it set a wait or finished, else failed and retried. One still running (a session of
 * his, or a killed turn's CLI not yet exited) is left to the begin limit; a runtime that can't say now is looked at
 * again at the next poll.
 */
export async function endLostTurns(desk: Desk) {
  const watching = watchedIn(desk.db);
  await eachOpenTurn(desk, async (a, t, runtime) => {
    if (watching.has(t.id)) {
      return;
    }
    const state =
      t.session && runtime
        ? await runtime.state(t.session).catch(() => null)
        : "gone";
    if (state === "idle" || state === "gone") {
      await turnEnded(desk, a.id, { ok: !!t.outcome });
      if (t.session) {
        await stopRun(runtime, a.id, t.session);
      }
    }
  });
}

/**
 * Ends each desk turn launched and not begun within `BEGIN_WITHIN_MS` (`isBeginLate`): a hung launch (a door that never
 * connects, a stuck adapter). The turn is ended first (a first turn: its agent not started, its matter freed; a later
 * one failed, retried), then its run stopped, whose end then finds the turn closed.
 */
export async function endUnbegunTurns(desk: Desk) {
  const at = clock().getTime();
  await eachOpenTurn(desk, async (a, t, runtime) => {
    if (!(runtime && isBeginLate(t, at))) {
      return;
    }
    await turnEnded(desk, a.id, {
      ok: false,
      why: `it did not begin within ${BEGIN_WITHIN_MS / MIN} minutes`,
    });
    if (t.session) {
      await stopRun(runtime, a.id, t.session);
    }
  });
}
