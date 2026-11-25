import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { clock, HOUR } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { DESK_AGENT } from "../core/names";
import { isOwnLife } from "../core/platform";
import { exec } from "../core/proc";
import {
  type AgentRow,
  type AssignmentRow,
  agentOf,
  anchorsOf,
  assignmentOf,
  assignmentOfCard,
  type EventRow,
  filtersOf,
  lastTurns,
  openAssignments,
  openTurn,
  queuedEvents,
  readCursor,
  turnModelOf,
} from "../host/desk-read";
import { isOnOrAfter } from "../host/event-channels";
import {
  CALL_ENDED,
  callMatchableOf,
  DECISION_ANSWERED,
  DECISION_EVENTS,
  DRAFT_CONTESTED,
  DRAFT_KEPT,
  MESSAGE_RECEIVED,
  matcherOf,
  messageMatchableOf,
  pollDecisions,
  readEndedCalls,
  readMessageEvents,
} from "../host/events";
import {
  MOVE_NOTES,
  moveFirstTurnOf,
  moveOn,
  notesTurnsOf,
} from "../host/move-read";
import {
  hasLeftOf,
  readOpenSessionRecords,
  sessionOpenInOf,
  TERMINAL_ENTRYPOINT,
  TERMINAL_SESSIONS,
} from "../host/open-session-records";
import { monthBudgetOf, spendingStopOf } from "../host/spending";
import { MAX_PAGE } from "../memory/changes";
import { decisionsNow } from "../memory/decisions";
import { CONTEST_WAIT, cardsHearingOf } from "../memory/draft-contest";
import { instructionsFor } from "../memory/instructions";
import { readMatterBook } from "../memory/matters";
import { type People, readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { isWokenOnlyByHisWords } from "../records/registered-agent";
import { readStore, storeFiles, WATCH, withStore } from "../sources/lifelog";
import { recordingsOf } from "../sources/lifelog-speech";
import { matterRecordOf, readPacket } from "./agent-actions";
import { applyAgentChanges } from "./agent-changes";
import {
  advanceMoves,
  movedLineOf,
  notesMessageOf,
  writeRuntimeBlocks,
} from "./agent-moves";
import { eventLineOf, nextWakeOf, STARTS_PER_TICK } from "./agent-wait";
import { pollArrivals } from "./arrival-route";
import { CARETAKER_BRIEF, receiveComplaints } from "./complaint-intake";
import { type Desk, saveCursor } from "./desk-store";
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
import { firstTurnOf } from "./first-turns";
import { endAgentsWithoutCard, handOutNext } from "./hand-out-tick";
import { MAIN_BRIEF } from "./main-session";
import {
  endAgentsOnOverMatters,
  foldAssignments,
  MATTER_RELATED,
  netsOf,
  pollRecordings,
  relatedMessages,
} from "./matter-net";
import { standUp } from "./role-agents";
import { blockOf, runnableAgentOf } from "./runtime-fallback";
import { SessionLive } from "./runtimes/contract";
import { receiveSpokenAsks } from "./spoken-ask-intake";
import {
  endLostTurns,
  endUnbegunTurns,
  recordSession,
  sessionAgentOf,
  turnEnded,
  watch,
} from "./turn-ends";

// The desk's clock (the desk spec, sections 6 and 7): one tick polls his answers and the messages its agents wait for
// into their queues, then starts the turns that are due; each turn ends when its run does (`Run.ended`). Everything is
// read from the store each time, so a sleep or a restart loses nothing.

const now = () => clock().toISOString();

/** The sessions a due wake found open outside the desk, by agent and session, logged once each until a wake finds them free. ponytail: per process, so a desk restart logs a hold once more. */
const openSessions = new Set<string>();

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
 * Queues his answers to the agents' decisions, their lapses and their withdrawals (for them), for the open assignment
 * that owns each (`assignmentOfCard`) and the one whose card it merged (`merges`), whatever its agent's status (a
 * stopped holder, or one a move is leaving, reads it at its next wake), in the transaction that saves each cursor: read
 * through `pollDecisions`, as the desk (every registered agent asks as it). Then each card's contest, facts only:
 * `draft.contested` to the holder of the card a card waits on, `draft.kept` to the waiting card's own (once each,
 * `queue`).
 */
export function pollAnswers({ db }: Desk) {
  const reads = DECISION_EVENTS.map((name) => ({
    name,
    read: pollDecisions(name, readCursor(db, name), DESK_AGENT),
  }));
  // Read after the polls, so every decision they return is known.
  const all = decisionsNow();
  const cards = new Map(all.map((d) => [d.id, d]));
  const wakesOf = (
    ids: (string | undefined)[],
    eventId: string,
    payload: unknown
  ) =>
    ids.flatMap((id) => {
      const card = id ? cards.get(id) : undefined;
      const assignment = card && assignmentOfCard(db, card);
      return assignment && assignmentOf(db, assignment)?.closed_at === null
        ? [{ assignment, eventId, payload }]
        : [];
    });
  for (const { name, read } of reads) {
    db.transaction(() => {
      queue(
        db,
        name,
        read.events.flatMap((e) => {
          const card = cards.get(e.data.id);
          const [, ...merged] = card ? cardsHearingOf(card, all) : [];
          return [
            ...wakesOf([e.data.id], e.eventId, e.data),
            // The merged card's agent hears his answer, never the holder's words or its `onSilence`.
            ...wakesOf(
              merged.map((m) => m.id),
              e.eventId,
              { ...e.data, onSilence: null, question: undefined }
            ),
          ];
        })
      );
      saveCursor(db, name, read.cursor);
    })();
  }
  const waiting = [...cards.values()].filter((d) => d.state === "waiting");
  // A keep is heard even when its card settled before this poll.
  const kept = [...cards.values()].filter((d) => d.kept);
  db.transaction(() => {
    queue(
      db,
      DRAFT_CONTESTED,
      waiting.flatMap((d) =>
        d.kept
          ? []
          : wakesOf([d.contests], `${d.id}.${DRAFT_CONTESTED}`, {
              asker: d.agent ?? d.asker,
              channel: d.draft?.channel,
              chat: d.draft?.chat,
              held: d.contests,
              id: d.id,
              until: new Date(Date.parse(d.at) + CONTEST_WAIT).toISOString(),
            })
      )
    );
    queue(
      db,
      DRAFT_KEPT,
      kept.flatMap((d) =>
        wakesOf([d.id], `${d.id}.${DRAFT_KEPT}`, { held: d.contests, id: d.id })
      )
    );
  })();
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

/**
 * When assignment `s` of agent `a` is next due and why (`nextWakeOf`), as read now, with its rank: his answer 0, a first
 * turn 1, any other 2. Null unless `a` is active and holds `s`, `s` is open and `a` runs no desk turn (its session takes
 * one at a time). The one due rule: the tick's choice (`wakeDue`) and the turn's write (`wake`) both read it.
 */
function dueOf(db: Desk["db"], agent: string, assignment: string) {
  const a = agentOf(db, agent);
  const s = assignmentOf(db, assignment);
  if (
    !(a?.status === "active" && s?.closed_at === null && s.agent_id === a.id) ||
    isWokenOnlyByHisWords(a.role) ||
    openTurn(db, a.id)
  ) {
    return null;
  }
  const m = moveOn(db, s);
  if (m && !m.moved_at) {
    // A move's notes phase: one notes turn on each assignment it covers, at once; then nothing until the commit.
    return notesTurnsOf(db, m).some((t) => t.assignment_id === s.id)
      ? null
      : {
          a,
          at: Date.parse(m.asked_at),
          cause: MOVE_NOTES,
          events: [],
          move: m.ask,
          rank: 1,
          s,
        };
  }
  // A committed move's first turn names it: its holder's first turn on what moved.
  const move = m && !moveFirstTurnOf(db, m) ? m.ask : null;
  const turns = lastTurns(db, s.id);
  const events = queuedEvents(db, s.id);
  const d = nextWakeOf(s, turns, events);
  if (!d) {
    return null;
  }
  // His answer first; a contest or a lapse (also at once) goes with the first turns.
  let rank = 2;
  if (events.some((e) => e.name === DECISION_ANSWERED)) {
    rank = 0;
  } else if (d.cause === "answer" || turns.length === 0 || move) {
    rank = 1;
  }
  return { ...d, a, events, move, rank, s };
}

/** The holders ended, each once: a holder still ending stays in its record a moment. ponytail: grows by one pid per take-back, for the helper's life. */
const takenBack = new Set<number>();

/**
 * Takes agent `a`'s session back from his Mac once he left it (`hasLeftOf`, his ruling of 22 Nov 2026: no button, Life
 * takes control back by itself): its holder (Life's Terminal launcher, or his Claude app's process for it, each checked by
 * its command line) is ended with SIGTERM, logged once, and the next tick wakes it. Never the desk's own runs (`sdk-*`).
 */
async function takeBackIfLeft(a: AgentRow) {
  const r = a.session ? readOpenSessionRecords().get(a.session) : undefined;
  if (
    !(r && sessionOpenInOf(r) && hasLeftOf(r, clock().getTime())) ||
    takenBack.has(r.pid)
  ) {
    return;
  }
  // The holder checked by its command line, a record outliving its process (its pid reused) never ends another.
  const { stdout } = await exec(["ps", "-o", "command=", "-p", String(r.pid)]);
  const holder =
    r.entrypoint === TERMINAL_ENTRYPOINT ? "pi-terminal" : "claude";
  if (!stdout.toLowerCase().includes(holder)) {
    // Life's own record outlived its launcher: dropped, so its pid's new owner never holds the agent's wakes.
    if (r.entrypoint === TERMINAL_ENTRYPOINT) {
      rmSync(join(TERMINAL_SESSIONS, `${r.pid}.json`), { force: true });
    }
    return;
  }
  try {
    process.kill(r.pid, "SIGTERM");
    takenBack.add(r.pid);
    log("desk.session_taken_back", { agent: a.id, runtime: a.runtime });
  } catch (e) {
    log("desk.session_taken_back", { agent: a.id, ok: false, ...errorOf(e) });
  }
}

/**
 * Starts a turn of `a` on its assignment `s`, or leaves a session running a turn of his alone (false: the wake comes
 * after it). The turn is written before the runtime is called, so the turn's end, however soon, finds it; its queued
 * events count a try once it begins (`markBegun`). It always resumes its one session, whose runtime compacts it when
 * full; only a session that is gone is replaced, by a fresh one from its packet (the old one's link kept). A runtime that
 * fails ends it failed, tried again later.
 */
async function wake(
  desk: Desk,
  a: AgentRow,
  s: AssignmentRow,
  stop?: SpendingStop
) {
  const { db } = desk;
  const runtime = desk.runtimes[a.runtime];
  // null: the runtime can't say; the send then tells.
  const state =
    a.session && runtime
      ? await runtime.state(a.session).catch(() => null)
      : "gone";
  if (state === "running") {
    // A due wake on a session open outside the desk (his app, a terminal) waits until it lets go: said once per opening.
    const key = `${a.id} ${a.session}`;
    if (!openSessions.has(key)) {
      openSessions.add(key);
      log("desk.session_open", { agent: a.id, runtime: a.runtime });
    }
    await takeBackIfLeft(a);
    return false;
  }
  openSessions.delete(`${a.id} ${a.session}`);
  // Read again as its turn is written: since the tick listed it, the agent may have finished, set a later wait or been
  // woken (a runtime's start can take 30 s); its session takes one turn at a time.
  const woken = db.transaction(() => {
    const found = dueOf(db, a.id, s.id);
    if (!found || found.at > clock().getTime()) {
      return null;
    }
    // His answer since the tick's read goes first: the stop is asked on a wake of its own only.
    const due =
      stop && found.rank > 0 ? { ...found, cause: SPENDING_STOP } : found;
    const id = db.run(
      "insert into turn (agent_id, assignment_id, session, cause, started_at, model, move) values (?, ?, ?, ?, ?, ?, ?)",
      [
        a.id,
        s.id,
        due.a.session,
        due.cause,
        now(),
        turnModelOf(due.a),
        due.move,
      ]
    ).lastInsertRowid;
    return { ...due, turn: Number(id) };
  })();
  if (!woken) {
    return false;
  }
  return woken.cause === MOVE_NOTES
    ? await launchNotes(desk, woken, state === "gone" ? null : a.session)
    : await launch(
        desk,
        {
          ...woken,
          said: woken.cause === SPENDING_STOP ? stop?.line : undefined,
        },
        state
      );
}

/** Launches move `move`'s notes turn `turn` of `a` on `s`: it resumes the old session only; with none to resume (`session` null), or a send that fails, the turn ends at once and its notes stay as they are. False: the session was live elsewhere, so the turn went and the wake waits. */
async function launchNotes(
  desk: Desk,
  {
    a,
    move,
    s,
    turn,
  }: { a: AgentRow; move: string | null; s: AssignmentRow; turn: number },
  session: string | null
) {
  const runtime = desk.runtimes[a.runtime];
  if (!(session && runtime)) {
    await turnEnded(desk, turn, { ok: true });
    return true;
  }
  try {
    watch(
      desk,
      turn,
      await runtime.send(
        sessionAgentOf(a),
        session,
        notesMessageOf(desk.db, move ?? "", s.id)
      )
    );
  } catch (error) {
    if (error instanceof SessionLive) {
      desk.db.run("delete from turn where id = ? and begun_at is null", [turn]);
      return false;
    }
    log("desk.runtime", {
      agent: a.id,
      ...errorOf(error),
      ok: false,
      what: "notes",
    });
    await turnEnded(desk, turn, { ok: false, why: errorOf(error).error });
  }
  return true;
}

/** Launches turn `turn` of `a` on `s` in its runtime, as `wake` wrote it; a launch that fails ends the turn failed. False: the session was live elsewhere, so the turn went and the wake waits. */
async function launch(
  desk: Desk,
  {
    a,
    cause,
    events,
    move,
    s,
    said,
    turn,
  }: {
    a: AgentRow;
    cause: string;
    events: EventRow[];
    move: string | null;
    s: AssignmentRow;
    /** A line the desk says on this wake (the spending stop's). */
    said?: string;
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
    const moved = [
      ...(move ? movedLineOf(db, move) : []),
      ...(said ? [said] : []),
    ];
    // A fresh session's packet holds the whole matter, read once for what it shows and what the turn is shown; a matter
    // given to a session already open (handed out, or his Start) opens with what its first turn does.
    const isFirst = !lastTurns(db, s.id).some((t) => t.id < turn);
    const record =
      isOwn || isFresh
        ? null
        : [
            await matterRecordOf(desk, s, turn),
            ...(isFirst ? [firstTurnOf(db, a, s).trim()] : []),
          ].join("\n");
    if (isFresh) {
      const started = await runtime.start(
        sessionAgentOf(a),
        [
          await readPacket(desk, s, isOwnLife(), turn),
          ...moved,
          ...sinceLineOf(since),
          ...unreadLinesOf(db, s),
        ].join("\n\n")
      );
      // Watched first: its process runs, so a failed write below never ends it as not started.
      watch(desk, turn, started);
      recordSession(desk, a, turn, started);
    } else {
      watch(
        desk,
        turn,
        await runtime.send(
          sessionAgentOf(a),
          session,
          wakeMessageOf(
            cause,
            events,
            record ? [record, ...moved] : [...sinceLineOf(since), ...moved],
            unreadLinesOf(db, s)
          )
        )
      );
    }
  } catch (error) {
    // His app took the session between `wake`'s read and the send: the turn never ran, so it goes and the wake waits.
    // ponytail: one taken after the send's own read, in the milliseconds before ACP resumes it, still runs beside it.
    if (error instanceof SessionLive) {
      db.run("delete from turn where id = ? and begun_at is null", [turn]);
      return false;
    }
    log("desk.runtime", {
      agent: a.id,
      ...errorOf(error),
      ok: false,
      what: "wake",
    });
    await turnEnded(desk, turn, { ok: false, why: errorOf(error).error });
  }
  return true;
}

/** A wake that asks him about a piece of work at its spending stop. */
const SPENDING_STOP = "spending_stop";
/** How much later a wake that is not his answer comes once the month's amount is passed. */
const SLOW_BY = HOUR;

/** A wake at the spending stop, with what the desk tells the agent. */
interface SpendingStop {
  line: string;
}

/** What assignment `id`'s turns were billed, how many asked at its stop, and the last of those and of his answers. */
const spentOf = (db: Desk["db"], id: string) =>
  db
    .query<
      {
        answered: number | null;
        asked: number | null;
        stops: number;
        usd: number;
      },
      [string, string]
    >(
      "select coalesce(sum(cost_usd), 0) + coalesce(sum(search_usd), 0) as usd, coalesce(sum(cause = ?1), 0) as stops, max(case when cause = ?1 then id end) as asked, max(case when cause = 'answer' then id end) as answered from turn where assignment_id = ?2"
    )
    .get(SPENDING_STOP, id);

/**
 * Where assignment `s` stands against its spending stop (`spendingStopOf`), for a wake that is not his answer: `waits`
 * once it asked him at its stop and he has not answered; a stop to ask at when what its turns were billed reached the
 * stop again (each answer to a stop gives it one more); null otherwise. ponytail: read between turns, so a turn may
 * run past its stop by what one turn spends.
 */
async function spendingStopNow(
  db: Desk["db"],
  s: AssignmentRow,
  monthly: number | undefined
): Promise<SpendingStop | "waits" | null> {
  const r = spentOf(db, s.id);
  if (!r) {
    return null;
  }
  if (r.asked !== null && r.asked > (r.answered ?? 0)) {
    return "waits";
  }
  const budget = s.matter_id
    ? instructionsFor({ matter: s.matter_id }).find(
        (i) => i.effect === "budget"
      )?.text
    : undefined;
  const base = spendingStopOf(monthly, false, budget);
  if (base === undefined || r.usd < base * (r.stops + 1)) {
    return null;
  }
  // Read only at the stop: whether he marked its matter important, which triples it.
  const isImportant =
    !budget &&
    s.matter_id !== null &&
    (await readMatterBook(await readPeople(), dayNow())).some(
      (v) => v.id === s.matter_id && v.important
    );
  const stop =
    (spendingStopOf(monthly, isImportant, budget) ?? base) * (r.stops + 1);
  return r.usd < stop
    ? null
    : {
        line: `This work has been billed ${r.usd.toFixed(2)} dollars, past its spending stop of ${stop.toFixed(2)}. End this turn with what you have and ask one card about the work, not the money ("Finding a clinic is taking longer than usual. Keep going?"), with what was spent as its context's last line. Until it is answered, nothing wakes you but the answer.`,
      };
}

/**
 * Starts the turns due now: his answers and new assignments' first turns first, then the oldest deadline, until 3 have
 * started this tick (an agent whose session runs a turn, of the desk's or his, or whose runtime is blocked, takes no
 * place; one with no session yet takes pi first, `runnableAgentOf`). Each is read again as its turn is written.
 */
export async function wakeDue(desk: Desk) {
  const t = clock().getTime();
  const month = monthBudgetOf();
  // Past the month's amount, background work slows: his answers still wake at once (recording and answering never stop).
  const slowBy = month?.isPassed ? SLOW_BY : 0;
  const due = openAssignments(desk.db)
    .flatMap((s) => {
      const d = dueOf(desk.db, s.agent_id, s.id);
      return d && d.at + (d.rank > 0 ? slowBy : 0) <= t ? [d] : [];
    })
    .toSorted((x, y) => x.rank - y.rank || x.at - y.at);
  // Each runtime asked once a tick, and only when a turn of it is due: a blocked one starts nothing, so no try is spent.
  const blocks = new Map<string, Promise<string | undefined>>();
  const blockOnce = (runtime: string) => {
    const b = blocks.get(runtime) ?? blockOf(desk, runtime);
    blocks.set(runtime, b);
    return b;
  };
  let started = 0;
  for (const d of due) {
    if (started === STARTS_PER_TICK) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: whether one started decides whether the next may
    const a = await runnableAgentOf(desk, d.a, blockOnce);
    // A runtime paused on its failing provider waits too (`Runtime.paused`): only here, never for his own asks.
    const stop =
      d.rank > 0 ? await spendingStopNow(desk.db, d.s, month?.monthly) : null;
    if (
      stop !== "waits" &&
      !((await blockOnce(a.runtime)) || desk.runtimes[a.runtime]?.paused?.())
    ) {
      started += (await wake(desk, a, d.s, stop ?? undefined)) ? 1 : 0;
    }
  }
}

/**
 * One tick of the clock: his word about his agents, each move one step on (`advanceMoves`), his complaints for the caretaker and his spoken asks for their agent (before the hand-out may take the last place), the hand-out (at most one start, a look every 10 minutes), his answers, the turns that never began, then the turns due (a new
 * agent's first turn never waits behind the polls), then, when their poll is due, what each runtime's block is, the messages, the calls that ended, the recordings, the
 * assignments whose matter is over for them, the fold (each matter to the agent that takes it), the hand-outs with no card in time and the turns lost to a restart (what they queue is woken next tick). The calls come after the messages, so a chat's messages and its call that ended are one burst; the event channels a wait names after the calls (`pollChannels`).
 */
export async function tick(desk: Desk, isPollDue = true) {
  await applyAgentChanges(desk);
  await advanceMoves(desk);
  standUp(desk, "main", MAIN_BRIEF);
  standUp(desk, "caretaker", CARETAKER_BRIEF);
  await receiveComplaints(desk);
  const people = readPeopleOnce();
  // A failure here never holds his answers or the turns due.
  await receiveSpokenAsks(desk, people).catch((error: unknown) =>
    log("desk.asks", { ...errorOf(error), ok: false })
  );
  await handOutNext(desk);
  pollAnswers(desk);
  await endUnbegunTurns(desk);
  await wakeDue(desk);
  if (isPollDue) {
    await writeRuntimeBlocks(desk);
    // A message a wait wants gets its `message.received` before any arrival falls back to another agent.
    if (await pollMessages(desk, people)) {
      await pollArrivals(desk, people);
    }
    await pollCalls(desk, people);
    await pollChannels(desk, people);
    await pollRecordings(desk, people);
    await endAgentsOnOverMatters(desk, people);
    await foldAssignments(desk, people);
    await endAgentsWithoutCard(desk);
    await endLostTurns(desk);
  }
}
