import { existsSync } from "node:fs";
import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { DESK_AGENT } from "../core/names";
import { isOwnLife } from "../core/platform";
import {
  type AgentRow,
  type AssignmentRow,
  activeAgents,
  agentOf,
  anchorsOf,
  assignmentOf,
  assignmentOfCard,
  type EventRow,
  filtersOf,
  isWaiting,
  lastTurns,
  modelOf,
  openAssignments,
  openTurn,
  queuedEvents,
  readCursor,
  type TurnRow,
} from "../host/desk-read";
import { isOnOrAfter } from "../host/event-channels";
import {
  CALL_ENDED,
  callMatchableOf,
  DECISION_EVENTS,
  MESSAGE_RECEIVED,
  matcherOf,
  messageMatchableOf,
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
import {
  commitAgentFiles,
  keepHanded,
  matterRecordOf,
  readPacket,
  stopOpenRun,
} from "./agent-actions";
import { applyAgentChanges } from "./agent-changes";
import {
  BEGIN_WITHIN_MS,
  defaultWaitOf,
  eventLineOf,
  failuresOf,
  isBeginLate,
  MAX_HANDED,
  nextWakeOf,
  STARTS_PER_TICK,
} from "./agent-wait";
import { pollArrivals } from "./arrival-route";
import { receiveComplaints } from "./complaint-intake";
import { doorOf } from "./desk-door";
import {
  closeAssignmentRow,
  type Desk,
  saveCursor,
  writeWait,
} from "./desk-store";
import {
  agentWakesOf,
  holdersOf,
  pollChannels,
  queue,
  type ReadPeople,
  routeOf,
  unreadLinesOf,
  type WakeWhy,
} from "./event-queue";
import { endAgentsWithoutCard, handOutNext } from "./hand-out-tick";
import {
  endAgentsOnOverMatters,
  MATTER_RELATED,
  netsOf,
  pollRecordings,
  relatedMessages,
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

/** `readPeople`, read at most once however often it is asked. */
export function readPeopleOnce(): ReadPeople {
  let read: Promise<People> | undefined;
  return () => {
    read ??= readPeople();
    return read;
  };
}

/**
 * Reads the new messages once and queues each for one open assignment of each agent it concerns (`routeOf`): one waiting
 * for it (`message.received`), else one on a matter it relates to (`relatedMessages`, `matter.related`), in the
 * transaction that saves the cursor (its name, `message.received`): delivered at least once, never twice. With none
 * open, nothing is read, and the next read starts at that time. Whether it has caught up (no message left unread):
 * only then may a confirmed arrival fall back to another agent (`pollArrivals`).
 */
export async function pollMessages(desk: Desk, readPeopleNow: ReadPeople) {
  const { db, sources } = desk;
  const assignments = openAssignments(db);
  if (assignments.length === 0) {
    saveCursor(db, MESSAGE_RECEIVED, null);
    return true;
  }
  const people = await readPeopleNow();
  const nets = await netsOf(desk, people);
  const matchers = assignments.flatMap((a) =>
    filtersOf(a).flatMap((f) => {
      const isMatch = matcherOf(f, people);
      return isMatch ? [{ id: a.id, isMatch, since: a.opened_at }] : [];
    })
  );
  const read = await readMessageEvents(
    readCursor(db, MESSAGE_RECEIVED),
    MAX_PAGE,
    people,
    (m, e) => {
      const ids = new Set(
        matchers
          .filter(
            (x) =>
              isOnOrAfter(m, x.since) && x.isMatch(messageMatchableOf(m, e))
          )
          .map((x) => x.id)
      );
      return ids.size || nets.length
        ? { fromMe: e.fromMe, ids, m, text: e.text }
        : null;
    },
    sources
  );
  const wakes = routeOf(
    [
      ...read.items.flatMap(({ ids, m }) =>
        [...ids].map((assignment) => ({
          assignment,
          by: { why: "wait" } as WakeWhy,
          eventId: m.id,
          name: MESSAGE_RECEIVED,
          payload: m as unknown,
        }))
      ),
      ...(await relatedMessages(desk, nets, read.items)).map((w) => ({
        ...w,
        name: MATTER_RELATED,
      })),
    ],
    holdersOf(db, assignments)
  );
  db.transaction(() => {
    for (const name of [MESSAGE_RECEIVED, MATTER_RELATED]) {
      queue(
        db,
        name,
        wakes.filter((w) => w.name === name)
      );
    }
    saveCursor(db, MESSAGE_RECEIVED, read.cursor);
  })();
  return !read.hasMore;
}

/**
 * Queues `call.ended` for each open assignment whose wait wants a call that ended in the last 12 hours
 * (`readEndedCalls`), once lifelog holds the call's words (`recordingsOf`): the chat, the span, who was on it and where
 * its turns are, never a word. A call with no turn inside (the pendant was off) queues nothing and is looked at again
 * next poll until it is 12 hours old; the queue keeps it once per agent and call (`queue`), so no cursor is kept. `at` is the time the polls look back from, passed
 * so a replay can set the evening.
 */
export async function pollCalls(
  desk: Desk,
  readPeopleNow: ReadPeople,
  at = clock().getTime(),
  watchDir = WATCH
) {
  const { db } = desk;
  const assignments = openAssignments(db);
  if (assignments.length === 0 || !existsSync(storeFiles(watchDir).file)) {
    return;
  }
  const people = await readPeopleNow();
  const wakes = agentWakesOf(
    db,
    assignments,
    people,
    readEndedCalls(people, desk.sources, at).map((call) => ({
      at: call.until,
      eventId: `${call.id}.ended`,
      matchable: callMatchableOf(call),
      payload: call,
    }))
  );
  if (wakes.length === 0) {
    return;
  }
  try {
    const recordings = await withStore(
      (store) =>
        new Map(
          wakes.map(({ payload: call }) => [
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
        wakes.flatMap(({ assignment, eventId, payload: call }) => {
          const found = recordings.get(call.id);
          return found
            ? [
                {
                  assignment,
                  eventId,
                  payload: { ...call, recordings: found },
                },
              ]
            : [];
        })
      )
    )();
  } catch (error) {
    log("desk.runtime", { ...errorOf(error), ok: false, what: "calls" });
  }
}

/**
 * Queues his answers to the agents' decisions, their lapses and their withdrawals (he answered in the chat), for the
 * open assignment that owns each (`assignmentOfCard`), in the transaction that saves each cursor: read through
 * `pollDecisions`, as the desk (every registered agent asks as it).
 */
export function pollAnswers({ db }: Desk) {
  const open = new Set(openAssignments(db).map((s) => s.id));
  const reads = DECISION_EVENTS.map((name) => ({
    name,
    read: pollDecisions(name, readCursor(db, name), DESK_AGENT),
  }));
  // Read after the polls, so every decision they return is known.
  const cards = new Map(decisionsNow().map((d) => [d.id, d]));
  for (const { name, read } of reads) {
    db.transaction(() => {
      queue(
        db,
        name,
        read.events.flatMap((e) => {
          const card = cards.get(e.data.id);
          const assignment = card && assignmentOfCard(db, card);
          return assignment && open.has(assignment)
            ? [{ assignment, eventId: e.eventId, payload: e.data }]
            : [];
        })
      );
      saveCursor(db, name, read.cursor);
    })();
  }
}

/** A deadline wake of an agent's own assignment: since when to sweep (`since`: when its last turn ended); none for another cause or a first turn. A matter's wake carries its record instead (`matterRecordOf`). */
const sinceLineOf = (since?: string) =>
  since
    ? [
        `Your last turn ended at ${since}: sweep what happened since then on your subject (\`read_memory_changes\` with \`since\`, \`read_matters\`, \`read_chats\`).`,
      ]
    : [];

/** The message that wakes a session: why, what it is woken on (its matter's record, or `sinceLineOf`), the channels it waits on that cannot be read (`unreadLinesOf`), and each queued event's facts (who, where, when, the id to read). */
const wakeMessageOf = (
  cause: string,
  events: EventRow[],
  on: string[],
  unread: string[]
) =>
  [
    `Woken by the desk: ${cause}.`,
    ...on,
    ...unread,
    ...events.map(eventLineOf),
  ].join("\n");

/** What a session of `a` is given: its door, its folder, a title, the model it runs with. */
const sessionAgentOf = (a: AgentRow): SessionAgent => ({
  ...modelOf(a),
  door: doorOf(a.id),
  folder: a.folder,
  id: a.id,
  title: (a.brief.trim().split("\n")[0] ?? "").slice(0, 60),
});

/** The turns whose run this process watches end (`Run.ended`): any other open turn was started before a restart. */
const watched = new WeakMap<Desk["db"], Set<number>>();
function watchedIn(db: Desk["db"]) {
  const turns = watched.get(db) ?? new Set<number>();
  watched.set(db, turns);
  return turns;
}

/**
 * Marks turn `turn` under way, once, and counts a try for each event queued before it was written (what it was handed):
 * a turn that never began (offline, out of quota) counts none, so it drops nothing.
 */
const markBegun = (db: Desk["db"], turn: number) =>
  db.transaction(() => {
    const t = db
      .query<Pick<TurnRow, "assignment_id" | "started_at">, [number]>(
        "select assignment_id, started_at from turn where id = ? and begun_at is null"
      )
      .get(turn);
    if (!t) {
      return;
    }
    db.run("update turn set begun_at = ? where id = ?", [now(), turn]);
    log("desk.turn", { assignment: t.assignment_id, phase: "begun", turn });
    db.run(
      "update event set handed = handed + 1 where assignment_id = ? and received_at <= ? and consumed_at is null and dropped_at is null",
      [t.assignment_id, t.started_at]
    );
  })();

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
        ...errorOf(error),
        ok: false,
        what: "end",
      })
    );
}

/**
 * Starts a turn of `a` on its assignment `s`, or leaves a session running a turn of his alone (false: the wake comes
 * after it). The turn is written before the runtime is called, so the turn's end, however soon, finds it; its queued
 * events count a try once it begins (`markBegun`). It always resumes its one session, whose runtime compacts it when
 * full; only a session that is gone is replaced, by a fresh one from its packet (the old one's link kept). A runtime that
 * fails ends it failed, tried again later.
 */
async function wake(desk: Desk, a: AgentRow, s: AssignmentRow) {
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
  // woken (a runtime's start can take 30 s); its session takes one turn at a time.
  const woken = db.transaction(() => {
    const fresh = agentOf(db, a.id);
    const freshS = assignmentOf(db, s.id);
    const events = queuedEvents(db, s.id);
    const due =
      fresh?.status === "active" &&
      freshS?.closed_at === null &&
      !openTurn(db, a.id)
        ? nextWakeOf(freshS, lastTurns(db, s.id), events)
        : null;
    if (!(fresh && freshS && due) || due.at > clock().getTime()) {
      return null;
    }
    const id = db.run(
      "insert into turn (agent_id, assignment_id, session, cause, started_at) values (?, ?, ?, ?, ?)",
      [a.id, s.id, fresh.session, due.cause, now()]
    ).lastInsertRowid;
    return {
      a: fresh,
      cause: due.cause,
      events,
      s: freshS,
      turn: Number(id),
    };
  })();
  if (!woken) {
    return false;
  }
  await launch(desk, woken, state);
  return true;
}

/** Launches turn `turn` of `a` on `s` in its runtime, as `wake` wrote it; a launch that fails ends the turn failed. */
async function launch(
  desk: Desk,
  {
    a,
    cause,
    events,
    s,
    turn,
  }: {
    a: AgentRow;
    cause: string;
    events: EventRow[];
    s: AssignmentRow;
    turn: number;
  },
  state: "running" | "idle" | "gone" | null
) {
  const { db } = desk;
  const runtime = desk.runtimes[a.runtime];
  const isOwn = anchorsOf(db, s.id).length === 0;
  const since =
    isOwn && cause === "deadline"
      ? (lastTurns(db, s.id).find((t) => t.id < turn && t.ended_at)?.ended_at ??
        undefined)
      : undefined;
  try {
    if (!runtime) {
      throw new Error(`no runtime ${a.runtime}`);
    }
    const { session } = a;
    const isFresh = !session || state === "gone";
    // A fresh session's packet holds the whole matter, read once for what it shows and what the turn is shown.
    const record =
      isOwn || isFresh ? null : await matterRecordOf(desk, s, turn);
    if (isFresh) {
      const started = await runtime.start(
        sessionAgentOf(a),
        [
          await readPacket(desk, s, isOwnLife(), turn),
          ...sinceLineOf(since),
          ...unreadLinesOf(db, s),
        ].join("\n\n")
      );
      // Watched first: its process runs, so a failed write below never ends it as not started.
      watch(desk, a.id, turn, started);
      try {
        db.transaction(() => {
          db.run(
            "update session set ended_at = ?, why_ended = 'fresh' where agent_id = ? and ended_at is null",
            [now(), a.id]
          );
          db.run(
            "insert into session (agent_id, runtime, ref, link, started_at) values (?, ?, ?, ?, ?)",
            [a.id, a.runtime, started.ref, started.link, now()]
          );
          db.run("update agent set session = ?, link = ? where id = ?", [
            started.ref,
            started.link,
            a.id,
          ]);
          db.run("update turn set session = ? where id = ?", [
            started.ref,
            turn,
          ]);
        })();
      } catch (error) {
        log("desk.runtime", {
          agent: a.id,
          ...errorOf(error),
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
          session,
          wakeMessageOf(
            cause,
            events,
            record ? [record] : sinceLineOf(since),
            unreadLinesOf(db, s)
          )
        )
      );
    }
  } catch (error) {
    log("desk.runtime", {
      agent: a.id,
      ...errorOf(error),
      ok: false,
      what: "wake",
    });
    await turnEnded(desk, a.id, { ok: false, why: errorOf(error).error });
  }
}

/**
 * Starts the turns due now: his answers and new assignments' first turns first, then the oldest deadline, until 3 have
 * started this tick (an agent whose session runs a turn, of the desk's or his, or whose runtime is blocked, takes no
 * place). Each is read again as its turn is written.
 */
export async function wakeDue(desk: Desk) {
  const t = clock().getTime();
  const due = openAssignments(desk.db)
    .flatMap((s) => {
      const a = agentOf(desk.db, s.agent_id);
      const turns = lastTurns(desk.db, s.id);
      const d =
        a && !openTurn(desk.db, a.id)
          ? nextWakeOf(s, turns, queuedEvents(desk.db, s.id))
          : null;
      return a && d && d.at <= t
        ? [
            {
              a,
              at: d.at,
              isAtOnce: d.cause === "answer" || turns.length === 0,
              s,
            },
          ]
        : [];
    })
    .toSorted((x, y) => Number(y.isAtOnce) - Number(x.isAtOnce) || x.at - y.at);
  // Each runtime asked once a tick, and only when a turn of it is due: a blocked one starts nothing, so no try is spent.
  const blocks = new Map<string, Promise<string | undefined>>();
  const blockOf = (runtime: string) => {
    const b =
      blocks.get(runtime) ??
      desk.runtimes[runtime]?.block() ??
      Promise.resolve(undefined);
    blocks.set(runtime, b);
    return b;
  };
  let started = 0;
  for (const d of due) {
    if (started === STARTS_PER_TICK) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: whether one started decides whether the next may
    if (!(await blockOf(d.a.runtime))) {
      started += (await wake(desk, d.a, d.s)) ? 1 : 0;
    }
  }
}

/**
 * One tick of the clock: his word about his agents, his complaints for the caretaker (before the hand-out may take the last place), the hand-out (at most one start, a look every 10 minutes), his answers, the turns that never began, then the turns due (a new
 * agent's first turn never waits behind the polls), then, when their poll is due, the messages, the calls that ended, the recordings, the
 * agents whose matter is over for them, the hand-outs with no card in time and the turns lost to a restart (what they queue is woken next tick). The calls come after the messages, so a chat's messages and its call that ended are one burst; the event channels a wait names after the calls (`pollChannels`).
 */
export async function tick(desk: Desk, isPollDue = true) {
  await applyAgentChanges(desk);
  await receiveComplaints(desk);
  await handOutNext(desk);
  pollAnswers(desk);
  await endUnbegunTurns(desk);
  await wakeDue(desk);
  if (isPollDue) {
    const people = readPeopleOnce();
    // A message a wait wants gets its `message.received` before any arrival falls back to another agent.
    if (await pollMessages(desk, people)) {
      await pollArrivals(desk, people);
    }
    await pollCalls(desk, people);
    await pollChannels(desk, people);
    await pollRecordings(desk, people);
    await endAgentsOnOverMatters(desk, people);
    await endAgentsWithoutCard(desk);
    await endLostTurns(desk);
  }
}

/**
 * Ends a turn, once (a turn already ended is left as it is): its handed events consumed when it waited or finished,
 * else handed again later, and dropped once handed to `MAX_HANDED` turns that began.
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
  keepHanded(db, t, ended > 0 && outcome !== "failed");
  if (ended === 0) {
    return false;
  }
  log("desk.turn", {
    assignment: t.assignment_id,
    ok: outcome !== "failed",
    outcome,
    phase: "ended",
    tokensOut: usage?.tokensOut,
    turn: t.id,
  });
  db.run(
    outcome === "waited" || outcome === "finished"
      ? "update event set consumed_at = ? where assignment_id = ? and handed > 0 and consumed_at is null and dropped_at is null"
      : `update event set dropped_at = ? where assignment_id = ? and handed >= ${MAX_HANDED} and consumed_at is null and dropped_at is null`,
    [now(), t.assignment_id]
  );
  return true;
}

/**
 * An assignment whose first turn failed before it began is closed, not retried, with why (`why_not_started`; its agent
 * ended when it has no other open): nothing is left running, its matter is free for a new start. Its only turn is `t`,
 * which never began.
 */
function endNotStarted({ db }: Desk, t: TurnRow, why: string) {
  if (lastTurns(db, t.assignment_id, 2).length !== 1 || t.begun_at) {
    return false;
  }
  closeAssignmentRow(db, t.assignment_id, {
    outcome: null,
    whyNotStarted: why,
  });
  return true;
}

/** After a failed turn of `s`: once its retries are spent, the default wait stands. */
function afterFailure({ db }: Desk, a: AgentRow, s: AssignmentRow) {
  if (isWaiting(a, s) && failuresOf(lastTurns(db, s.id)) >= MAX_HANDED) {
    writeWait(db, s.id, defaultWaitOf(s, clock().getTime()), true);
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
  const s = t && assignmentOf(db, t.assignment_id);
  if (!(t && a && s)) {
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
        afterFailure(desk, a, s);
      }
    })();
  } else if (t.outcome === "waited" || t.outcome === "finished") {
    close(desk, t, t.outcome, usage);
  } else if (await isReminded(desk, t, a)) {
    return;
  } else {
    db.transaction(() => {
      if (close(desk, t, "default_wait", usage) && isWaiting(a, s)) {
        writeWait(db, s.id, defaultWaitOf(s, clock().getTime()), true);
      }
    })();
  }
  commitAgentFiles(a, s);
}

/** Reminds turn `t` of `a` once to set a wait or finish, when it ended with neither: whether it was (the turn then runs on). */
async function isReminded(desk: Desk, t: TurnRow, a: AgentRow) {
  const runtime = desk.runtimes[a.runtime];
  // Only an agent still active is reminded: one he stopped mid-turn gets no extra run.
  if (!t.reminded_at && a.status === "active" && a.session && runtime) {
    // Marked before it is sent, so a turn ending at once is never reminded twice.
    desk.db.run("update turn set reminded_at = ? where id = ?", [now(), t.id]);
    try {
      watch(
        desk,
        a.id,
        t.id,
        await runtime.send(sessionAgentOf(a), a.session, REMINDER)
      );
      return true;
    } catch (error) {
      log("desk.runtime", {
        agent: a.id,
        ...errorOf(error),
        ok: false,
        what: "remind",
      });
    }
  }
  return false;
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
      await stopOpenRun(desk, a.id, t);
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
    await stopOpenRun(desk, a.id, t);
  });
}
