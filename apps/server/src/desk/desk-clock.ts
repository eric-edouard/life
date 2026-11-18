import { clock } from "../core/clock";
import { log } from "../core/log";
import { matcherOf, readMessageEvents } from "../host/events";
import { MAX_PAGE } from "../memory/changes";
import { readPeople } from "../memory/who";
import type { TurnEnd, TurnOutcome } from "../records/registered-agent";
import { readPacket } from "./agent-actions";
import {
  defaultWaitOf,
  dueOf,
  FRESH_AT,
  failuresOf,
  MAX_HANDED,
  STARTS_PER_TICK,
} from "./agent-wait";
import {
  type AgentRow,
  activeAgents,
  agentOf,
  type Desk,
  type EventRow,
  filtersOf,
  lastTurns,
  openTurn,
  queuedEvents,
  readCursor,
  saveCursor,
  type TurnRow,
  writeWait,
} from "./desk-store";

// The desk's clock (the desk spec, section 6): one tick polls the messages its agents wait for into their queues, then
// starts the turns that are due; a runtime reports each turn's end here. Everything is read from the store each time,
// so a sleep or a restart loses nothing.

/** The cursor of `message.received`, over every source. */
const MESSAGES = "message.received";
const REMINDER =
  "Before you stop, call `set_wait` (what you wait for, until when) or `finish`.";

const now = () => clock().toISOString();

/**
 * Reads the new messages once and queues each for every active agent waiting for it, in the transaction that saves
 * the cursor: delivered at least once, never twice (an event id is kept once per agent). With no agent waiting for
 * messages, nothing is read, and the next read starts at that time.
 */
export async function pollMessages({ db, sources }: Desk) {
  const agents = activeAgents(db).filter((a) => filtersOf(a).length > 0);
  if (agents.length === 0) {
    saveCursor(db, MESSAGES, null);
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
    readCursor(db, MESSAGES),
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
          [id, m.id, MESSAGES, JSON.stringify(m), now()]
        );
      }
    }
    saveCursor(db, MESSAGES, read.cursor);
  })();
}

/** The message that wakes a session: why, and each queued event's facts (who, where, when, the id to read). */
const wakeMessageOf = (cause: string, events: EventRow[]) =>
  [
    `Woken by the desk: ${cause}.`,
    ...events.map((e) => `${e.name} ${e.payload}`),
  ].join("\n");

/**
 * Starts a turn for `a`: into its session while that holds under 30,000 tokens, else a fresh session from its packet
 * (the old one's link kept). Each queued event is handed to it. A session running a turn of his is left alone: the
 * wake comes after it. A runtime that fails makes a failed turn, tried again later.
 */
async function wake(desk: Desk, a: AgentRow, cause: string) {
  const { db } = desk;
  const runtime = desk.runtimes[a.runtime];
  const events = queuedEvents(db, a.id);
  let ref: string | null = null;
  let isFailed = false;
  try {
    if (!runtime) {
      throw new Error(`no runtime ${a.runtime}`);
    }
    const state = a.session ? await runtime.state(a.session) : "gone";
    if (state === "running") {
      return;
    }
    const tokens = a.session ? await runtime.contextTokens(a.session) : null;
    if (!a.session || state === "gone" || (tokens ?? 0) >= FRESH_AT) {
      const s = await runtime.start(
        { folder: a.folder, id: a.id, title: a.brief.slice(0, 60) },
        readPacket(desk, a.id)
      );
      ({ ref } = s);
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
      })();
    } else {
      ({ ref } = await runtime.send(a.session, wakeMessageOf(cause, events)));
      db.run("update agent set session = ? where id = ?", [ref, a.id]);
    }
  } catch (error) {
    log("desk.runtime", {
      agent: a.id,
      error: String(error),
      ok: false,
      what: "wake",
    });
    isFailed = true;
  }
  db.transaction(() => {
    db.run(
      "insert into turn (agent_id, session, cause, started_at) values (?, ?, ?, ?)",
      [a.id, ref ?? a.session, cause, now()]
    );
    for (const e of events) {
      db.run(
        "update event set handed = handed + 1 where agent_id = ? and event_id = ?",
        [a.id, e.event_id]
      );
    }
  })();
  if (isFailed) {
    await turnEnded(desk, a.id, { failed: true });
  }
}

/** Starts the turns due now: his answers first, then the oldest deadline, at most 3 a tick. */
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
    )
    .slice(0, STARTS_PER_TICK);
  await Promise.all(due.map((d) => wake(desk, d.a, d.cause)));
}

/** One tick of the clock: the messages (when their poll is due), then the turns due. */
export async function tick(desk: Desk, isPollDue = true) {
  if (isPollDue) {
    await pollMessages(desk);
  }
  await wakeDue(desk);
}

/**
 * Ends a turn: its handed events consumed when it waited or finished, else handed again later, and dropped once handed
 * `MAX_HANDED` times.
 */
function close(desk: Desk, t: TurnRow, outcome: TurnOutcome, end: TurnEnd) {
  const { db } = desk;
  db.run(
    "update turn set ended_at = ?, outcome = ?, tokens_in = ?, tokens_cached = ?, tokens_out = ? where id = ?",
    [
      now(),
      outcome,
      end.tokensIn ?? null,
      end.tokensCached ?? null,
      end.tokensOut ?? null,
      t.id,
    ]
  );
  db.run(
    outcome === "waited" || outcome === "finished"
      ? "update event set consumed_at = ? where agent_id = ? and handed > 0 and consumed_at is null and dropped_at is null"
      : `update event set dropped_at = ? where agent_id = ? and handed >= ${MAX_HANDED} and consumed_at is null and dropped_at is null`,
    [now(), t.agent_id]
  );
}

/** After a failed turn: once the retries are spent, the default wait stands. */
function afterFailure({ db }: Desk, a: AgentRow) {
  if (a.status === "active" && failuresOf(lastTurns(db, a.id)) >= MAX_HANDED) {
    writeWait(db, a.id, defaultWaitOf(a, clock().getTime()), true);
  }
}

/**
 * A runtime reports that `id`'s session ended a turn. A turn the desk started ends by `set_wait` or `finish`; with
 * neither, the desk reminds it once, then sets the default wait. A turn the desk did not start is his own: counted,
 * nothing else.
 */
export async function turnEnded(desk: Desk, id: string, end: TurnEnd = {}) {
  const { db } = desk;
  const t = openTurn(db, id);
  const a = agentOf(db, id);
  if (!(t && a)) {
    db.run(
      "insert into turn (agent_id, session, cause, started_at, ended_at, outcome, tokens_in, tokens_cached, tokens_out) values (?, ?, 'his_own', ?, ?, 'his_own', ?, ?, ?)",
      [
        id,
        a?.session ?? null,
        now(),
        now(),
        end.tokensIn ?? null,
        end.tokensCached ?? null,
        end.tokensOut ?? null,
      ]
    );
    return;
  }
  if (end.failed) {
    db.transaction(() => {
      close(desk, t, "failed", end);
      afterFailure(desk, a);
    })();
    return;
  }
  if (t.outcome === "waited" || t.outcome === "finished") {
    close(desk, t, t.outcome, end);
    return;
  }
  if (!t.reminded_at && a.session && desk.runtimes[a.runtime]) {
    try {
      await desk.runtimes[a.runtime]?.send(a.session, REMINDER);
      db.run("update turn set reminded_at = ? where id = ?", [now(), t.id]);
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
    close(desk, t, "default_wait", end);
    if (a.status === "active") {
      writeWait(db, id, defaultWaitOf(a, clock().getTime()), true);
    }
  })();
}

/** On start: a desk turn its runtime no longer runs (the helper or the Mac stopped meanwhile) failed, and is retried. */
export async function recover(desk: Desk) {
  await Promise.all(
    activeAgents(desk.db).map(async (a) => {
      const t = openTurn(desk.db, a.id);
      const runtime = desk.runtimes[a.runtime];
      if (
        t &&
        (!(t.session && runtime) ||
          (await runtime.state(t.session)) !== "running")
      ) {
        await turnEnded(desk, a.id, { failed: true });
      }
    })
  );
}
