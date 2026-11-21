import { clock, SECOND } from "../core/clock";
import { readLines } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { ASK_SPOKEN } from "../host/events";
import { askOf, LEDGER, parseLedgerEntry } from "../memory/memory-files";
import { isSpokenAsk, type LedgerEntry } from "../records/ledger-entry";
import {
  type Desk,
  readSpokenAsksCursor,
  saveSpokenAsksCursor,
} from "./desk-store";
import {
  matterOrPersonalOf,
  queue,
  type ReadPeople,
  type WakeWhy,
} from "./event-queue";
import { readNets, relatedWords, wakeWhyShownOf } from "./matter-net";
import {
  PERSONAL_BRIEF,
  roleAssignmentOf,
  roleStartBlockOf,
} from "./role-agents";

// The desk's intake of his spoken asks ("hey Life", `host/hear.ts`: asks of the desk in the ledger), each tick after his
// complaints (his word of 21 Nov 2026: every ask of "hey Life" goes through the desk to the proper agent). Each ask goes
// to one agent, chosen in code (`matterOrPersonalOf`, no model): the open matter assignment its words are closest to in
// meaning (the wide net, `matter-net.ts`), else the Personal agent's own, registered by the desk when none stands
// (`roleAssignmentOf`). Its receipt is its `ask.spoken` event row (event id: the ask's id), looked for across every
// agent, so an ask is received once. From its own cursor (at most `ROWS_PER_TICK` new lines a tick, plus the asks that
// wait), each ask is placed alone: one waits while the embedder could not read the nets and it is under
// `SPOKEN_ROUTE_WAIT` old, or while no Personal place can be made (stopped, a full desk, a runtime that does not
// answer); never dropped, no age limit. An assignment that closes gives back what it never handed (`giveBack`).

const ROWS_PER_TICK = 1000;
/** How long a spoken ask waits for the embedder to place it by meaning, from when it was recorded; then the Personal agent. */
export const SPOKEN_ROUTE_WAIT = 20 * SECOND;
/** The least time the meaning read is given, so an ask received past its wait (the desk was off) is still tried by meaning once. */
const ROUTE_FLOOR = 5 * SECOND;

/** Where spoken ask `ask` was received (its `ask.spoken` event row, for any agent), or null before. */
const receiptOf = (db: Desk["db"], ask: string) =>
  db
    .query<{ assignment_id: string }, [string, string]>(
      "select assignment_id from event where name = ? and event_id = ?"
    )
    .get(ASK_SPOKEN, ask);

/** An `ask.spoken` event's facts: where his words are and why it came here, never the words. */
const payloadOf = (
  a: LedgerEntry,
  by: Exclude<WakeWhy, { why: "wait" | "person" }> | { why: "personal" }
) => ({
  ask: a.id,
  at: a.instruction?.at,
  by: by.why === "meaning" ? wakeWhyShownOf(by) : by,
  confidence: a.after.confidence,
  conversation: a.after.conversation,
  ref: a.instruction?.ref,
  until: a.timing?.ended,
});

/**
 * The nets each ask's words are close to, read within `ms`: a read that hangs or fails (logged) is not whole, so no
 * matter is chosen on it and the tick goes on.
 */
async function readRelated(
  desk: Desk,
  readPeopleNow: ReadPeople,
  asks: LedgerEntry[],
  ms: number
) {
  const read = async () => {
    const { isWhole, nets } = await readNets(desk, await readPeopleNow());
    const r = await relatedWords(
      desk,
      nets,
      asks.map((a) => a.instruction?.quote ?? "")
    );
    return { isWhole: isWhole && r.isWhole, related: r.related };
  };
  const none = { isWhole: false, related: [] };
  return await Promise.race([
    read().catch((error: unknown) => {
      log("desk.asks", { ...errorOf(error), ok: false, what: "route" });
      return none;
    }),
    Bun.sleep(ms).then(() => none),
  ]);
}

/** Receives his new spoken asks, each for one agent, once; what has no place yet waits for a later tick. */
export async function receiveSpokenAsks(desk: Desk, readPeopleNow: ReadPeople) {
  const { db } = desk;
  const cursor = readSpokenAsksCursor(db);
  // Its page's lines only (`readLines`): a tick parses no more of the ledger than it reads.
  const rows = Array.from(
    readLines(LEDGER, cursor.line, cursor.line + ROWS_PER_TICK),
    parseLedgerEntry
  );
  const asks = [
    ...cursor.waiting.flatMap((id) => askOf(id) ?? []),
    ...rows.flatMap((a) => (a && isSpokenAsk(a) ? [a] : [])),
  ].filter((a) => !receiptOf(db, a.id));
  const left = (a: LedgerEntry) =>
    Date.parse(a.at) + SPOKEN_ROUTE_WAIT - clock().getTime();
  // Bounded by the soonest ask's own wait, so none is held past it; one already past it gets a short try.
  const { isWhole, related } =
    asks.length > 0
      ? await readRelated(
          desk,
          readPeopleNow,
          asks,
          Math.max(ROUTE_FLOOR, Math.min(...asks.map(left)))
        )
      : { isWhole: true, related: [] };
  // Each ask's matter by meaning (his own words: no person), only on a whole read (a matter the embedder could not
  // read may be closer); else the Personal agent once the read was whole or the ask's own wait is over, by the clock now.
  const toMatters = asks.flatMap((a, i) => {
    if (!isWhole) {
      return [];
    }
    const near = related[i] ?? [];
    const assignment = matterOrPersonalOf(near, undefined);
    const by = near.find((r) => r.assignment === assignment)?.by;
    return assignment && by?.why === "meaning" ? [{ a, assignment, by }] : [];
  });
  const toPersonal = asks.filter(
    (a) => !toMatters.some((m) => m.a === a) && (isWhole || left(a) <= 0)
  );
  // A matter's asks first, alone: `queue` skips an assignment that closed meanwhile (the ask then waits).
  db.transaction(() =>
    queue(
      db,
      ASK_SPOKEN,
      toMatters.flatMap(({ a, assignment, by }) =>
        receiptOf(db, a.id)
          ? []
          : [{ assignment, eventId: a.id, payload: payloadOf(a, by) }]
      )
    )
  )();
  if (toPersonal.length > 0) {
    const newest = toPersonal.reduce((n, a) => (a.at > n ? a.at : n), "");
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
            toPersonal.flatMap((a) =>
              receiptOf(db, a.id)
                ? []
                : [
                    {
                      assignment: place.assignment,
                      eventId: a.id,
                      payload: payloadOf(a, { why: "personal" }),
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
        ...asks.map((a) => a.id),
      ]),
    ].filter((id) => !receiptOf(db, id));
    saveSpokenAsksCursor(db, {
      line: cursor.line + rows.length,
      waiting: ids,
    });
    return ids;
  })();
  const received = asks.filter((a) => receiptOf(db, a.id)).length;
  if (received > 0) {
    log("desk.asks", { received, waiting });
  }
}
