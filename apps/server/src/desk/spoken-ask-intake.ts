import { readLines } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import {
  type AssignmentRow,
  assignmentOf,
  currentAssignmentOf,
} from "../host/desk-read";
import { ASK_SPOKEN } from "../host/events";
import { askOf, LEDGER, parseLedgerEntry } from "../memory/memory-files";
import { isSpokenAsk, type LedgerEntry } from "../records/ledger-entry";
import { notifyPhone, pushIdOf } from "../sources/lifelog-push";
import {
  type Desk,
  readSpokenAsksCursor,
  saveSpokenAsksCursor,
} from "./desk-store";
import { queue } from "./event-queue";
import { askMainSession, isAsking } from "./main-session";
import {
  PERSONAL_BRIEF,
  roleAssignmentOf,
  roleStartBlockOf,
} from "./role-agents";
import { askEntryOf, endEntryWith, openEntry } from "./thread-entries";

// The desk's intake of his spoken asks ("hey Life", `host/hear.ts`: asks of the desk in the ledger), each tick after his
// complaints. Every spoken ask is one ask of the main session, as his words through Ask Life are (his decision of 27 Nov
// 2026: "The main session"; it hands work on with `tell_agent`), and always ends with something he sees (his "Yes,
// always reply" of that day): its thread entry, opened with Life's eyes and one push that Life heard him, then its
// answer or its error (`askMainSession`). Its receipt is that entry (`ask_key`: the ask's id), so an ask is asked once;
// it waits in the cursor until its entry is answered. One cut by a restart (its turn begun, held by no process) ends
// with a line saying so, never asked again: its acts would run twice. His words the main session handed to one agent
// (`after.to`, `tell_agent`) go to that assignment, else its agent's open one, else (its agent ended) to the Personal
// agent's (`toldPlaceOf`); their receipt is their `ask.spoken` event row, looked for across every agent. An assignment
// that closes gives back what it never handed (`giveBack`). From its own cursor, at most `ROWS_PER_TICK` new lines a
// tick, plus the asks that wait; never dropped, no age limit.

const ROWS_PER_TICK = 1000;

/** What he sees when a restart cut the main session's turn on his spoken ask. */
export const CUT_BY_RESTART =
  "Life restarted before it finished this: say it again.";

/** Where told ask `ask` was received (its `ask.spoken` event row, for any agent), or null before. */
const receiptOf = (db: Desk["db"], ask: string) =>
  db
    .query<{ assignment_id: string }, [string, string]>(
      "select assignment_id from event where name = ? and event_id = ?"
    )
    .get(ASK_SPOKEN, ask);

/** His words the main session handed to one agent (`after.to`, an assignment); else a spoken ask. */
const toldToOf = (a: LedgerEntry) =>
  typeof a.after.to === "string" ? a.after.to : undefined;

/**
 * Where his words told to assignment `to` go: there while it is open, else its agent's open assignment now; null when
 * there is none (its agent ended: they go to the Personal agent).
 */
function toldPlaceOf(db: Desk["db"], to: string) {
  const s = assignmentOf(db, to);
  if (!s || s.closed_at === null) {
    return s?.id ?? null;
  }
  const now = currentAssignmentOf(db, s.agent_id);
  return now?.closed_at === null ? now.id : null;
}

/** A told ask's `ask.spoken` facts: where his words are and the assignment they were told to, never the words. */
const payloadOf = (a: LedgerEntry, to: string) => ({
  ask: a.id,
  at: a.instruction?.at,
  by: { to, why: "told" as const },
});

/** Whether ask `a` needs nothing more here: told and received, or spoken and its entry answered or deleted. */
function isSettled(db: Desk["db"], a: LedgerEntry) {
  if (toldToOf(a)) {
    return Boolean(receiptOf(db, a.id));
  }
  const e = askEntryOf(db, a.id);
  return Boolean(e && (e.answered_at || e.deleted_at));
}

/** Where spoken ask `a` was said, when the hearing recorded it: its conversation and the turn it starts at. */
const spokenOf = (a: LedgerEntry) => {
  const { conversation, turns } = a.after;
  const turn = Array.isArray(turns) ? turns[0] : undefined;
  return typeof conversation === "string" && typeof turn === "number"
    ? { conversation, turn }
    : {};
};

/** What he sees on words heard with low confidence (a misheard wake, or another voice): no turn runs on them. */
export const NOT_SURE =
  "Life wasn't sure you were talking to it: say it again.";

/**
 * Spoken ask `a`, asked of the main session unless this process waits on it: one push that Life heard him, which its
 * outcome replaces (the same `pushId`; never his words or Life's through Apple). Words heard with low confidence run no
 * turn, and one a restart cut (its turn begun) is not asked again: its acts would run twice. Each ends with a line.
 */
function askSpoken(desk: Desk, a: LedgerEntry) {
  const { db } = desk;
  if (isAsking(desk, a.id)) {
    return;
  }
  const outcome =
    (title: string, body = "Open Life to read it.") =>
    () =>
      notifyPhone({
        body,
        kind: "thread.reply",
        pushId: pushIdOf(`thread:${askEntryOf(db, a.id)?.id}`),
        title,
      });
  const before = askEntryOf(db, a.id);
  const why = before?.turn_id
    ? CUT_BY_RESTART
    : a.after.confidence === "low" && NOT_SURE;
  if (why) {
    endEntryWith(
      db,
      before?.id ?? openEntry(db, { key: a.id, words: a.instruction?.quote }),
      why,
      true
    );
    outcome("Life couldn't do it")();
    return;
  }
  // Not waited for: a turn of minutes never holds the tick.
  const answered = askMainSession(
    desk,
    {
      key: a.id,
      spoken: spokenOf(a),
      words: a.instruction?.quote ?? "",
    },
    () => undefined
  );
  const heard = before
    ? Promise.resolve(true)
    : outcome("Life heard you", "On it.")();
  // The outcome after the heard push, so his phone ends on it.
  Promise.all([answered, heard])
    .then(([x]) =>
      outcome(x.kind === "error" ? "Life couldn't do it" : "Life answered")()
    )
    .catch((error: unknown) =>
      log("desk.asks", { ...errorOf(error), ok: false, what: "main" })
    );
}

/** Receives his new spoken asks, each once: a spoken one asked of the main session, a told one queued for its agent. */
export async function receiveSpokenAsks(desk: Desk) {
  const { db } = desk;
  const cursor = readSpokenAsksCursor(db);
  // Its page's lines only (`readLines`): a tick parses no more of the ledger than it reads.
  const rows = Array.from(
    readLines(LEDGER, cursor.line, cursor.line + ROWS_PER_TICK),
    parseLedgerEntry
  );
  const all = [
    ...cursor.waiting.flatMap((id) => askOf(id) ?? []),
    ...rows.flatMap((a) => (a && isSpokenAsk(a) ? [a] : [])),
  ].filter((a) => !isSettled(db, a));
  for (const a of all) {
    if (!toldToOf(a)) {
      askSpoken(desk, a);
    }
  }
  const told = all.flatMap((a) => {
    const to = toldToOf(a);
    return to ? [{ a, place: toldPlaceOf(db, to), to }] : [];
  });
  db.transaction(() =>
    queue(
      db,
      ASK_SPOKEN,
      told.flatMap(({ a, place, to }) =>
        place
          ? [{ assignment: place, eventId: a.id, payload: payloadOf(a, to) }]
          : []
      )
    )
  )();
  const orphans = told.filter(({ place }) => !place);
  if (orphans.length > 0) {
    const newest = orphans.reduce((n, { a }) => (a.at > n ? a.at : n), "");
    const blocked = await roleStartBlockOf(desk, "personal", () => newest);
    try {
      db.transaction(() => {
        const place = roleAssignmentOf(
          desk,
          "personal",
          PERSONAL_BRIEF,
          blocked
        );
        if ("assignment" in place) {
          queue(
            db,
            ASK_SPOKEN,
            orphans.flatMap(({ a, to }) =>
              receiptOf(db, a.id)
                ? []
                : [
                    {
                      assignment: place.assignment,
                      eventId: a.id,
                      payload: payloadOf(a, to),
                    },
                  ]
            )
          );
        }
      })();
    } catch (error) {
      // Registering the Personal agent failed (its home not made): its asks wait for the next tick.
      log("desk.asks", { ...errorOf(error), ok: false });
    }
  }
  // The cursor as it stands now (an assignment that closed meanwhile gave asks back into it), in one transaction.
  const waiting = db.transaction(() => {
    const ids = [
      ...new Set([
        ...readSpokenAsksCursor(db).waiting,
        ...all.map((a) => a.id),
      ]),
    ].filter((id) => {
      const a = askOf(id);
      return a ? !isSettled(db, a) : false;
    });
    saveSpokenAsksCursor(db, {
      line: cursor.line + rows.length,
      waiting: ids,
    });
    return ids;
  })();
  if (all.length > 0) {
    log("desk.asks", { received: all.length - waiting.length, waiting });
  }
}

/**
 * His words through Ask Life that the main session told an agent (`tell_agent`), as that agent reads them through its
 * door (`read_spoken_ask`): only one received on assignment `s` (its `ask.spoken` event there). Verbatim, as data.
 */
export function readSpokenAsk(
  { db }: Desk,
  s: Pick<AssignmentRow, "id">,
  ask: string
) {
  const a = receiptOf(db, ask)?.assignment_id === s.id ? askOf(ask) : undefined;
  if (!(a?.instruction && isSpokenAsk(a) && toldToOf(a))) {
    return { error: `Not done: no spoken ask ${ask} was received here.` };
  }
  return { at: a.instruction.at, words: a.instruction.quote };
}
