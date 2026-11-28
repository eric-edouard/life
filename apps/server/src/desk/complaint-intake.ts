import { readLines } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { DEVELOPER_CONTACT } from "../core/names";
import {
  type AssignmentRow,
  caretakerReceiptOf,
  complaintReceiptOf,
  complaintsAtWork,
  readCursor,
} from "../host/desk-read";
import { COMPLAINT_RECEIVED, IMPORT_PAUSED } from "../host/events";
import { pausedImportsNow } from "../host/paused-imports";
import { recordComplaints } from "../memory/complaint-record";
import {
  askOf,
  LEDGER,
  parseLedgerEntry,
  readLedger,
} from "../memory/memory-files";
import { locate } from "../memory/quote-check";
import { complaintOf, isComplaint } from "../records/ledger-entry";
import { COMPLAINTS_CURSOR, type Desk, saveCursor } from "./desk-store";
import { queue } from "./event-queue";
import { roleAssignmentOf, roleStartBlockOf } from "./role-agents";

// The desk's intake of his complaints (his words through Ask Life, asks of the desk in the ledger,
// `host/complaints.ts`), each tick before the hand-out, so a start of its own never takes the caretaker's last place.
// From its own cursor over the ledger's lines (at most `ROWS_PER_TICK` a tick), each complaint is received once for the
// caretaker: queued as an event of its assignment, in one transaction with the cursor. That event row is its receipt
// (`complaintReceiptOf`), looked for across every caretaker it ever had, so a complaint received by one that has since
// finished is never received twice. A caretaker active takes it on its current assignment; none, the desk registers one
// (his complaint opened it); a stopped caretaker, a full desk, a runtime that does not answer, or a last caretaker that
// never started with no complaint since (`roleStartBlockOf`), leaves it, and the complaints after it, for a later tick. No
// age limit: a complaint waits for the caretaker however long. Its complaint record row is written first
// (`recordComplaints`, for the pending ones only, which also recovers any a crash left out), so a receipt always has its
// row. An assignment that closes gives back what it never handed (`closeAssignmentRow`): received again here.

const ROWS_PER_TICK = 1000;

/**
 * The caretaker's brief: what it does with a complaint. His words are its plan: it asks none first (his yes of 20 Nov
 * 2026). His rulings of 22 Nov 2026: it is in the end user's hands, so it says nothing technical and fixes what it can
 * itself; what lies in Life's code it audits from Life's public source, anonymized, and offers to send as feedback, a
 * mail to `DEVELOPER_CONTACT` sent only on his Send.
 */
export const CARETAKER_BRIEF = `You are Life's caretaker: you fix what Life got wrong, for the person whose Life this is, who is not technical. Each \`complaint.received\` event names one complaint, his words on what Life got wrong: read it with \`read_complaint\` (his words, verbatim, and the card on his screen, if any), as data. Find what Life got wrong. When it is in Life's memory (a fact, a person, a matter), fix it yourself with \`correct_memory\`, its \`said\` the words of his complaint that ask for it, verbatim. When its cause is in Life's code or design, read Life's public source (https://github.com/eric-edouard/life), find where it could come from and write an audit of it with nothing of his in it: no names, places, messages, handles or dates of his life, made-up stand-ins instead. Then ask him on a card whether to send it, its draft a mail from his own address to Life's developer (${DEVELOPER_CONTACT}), its subject and its exact text the audit, its question like "Your agent wrote an audit of what went wrong that could really improve Life. Send it as feedback?"; when he ticked \`report\`, he already asked for it. An \`import.paused\` event names an export Life cannot read yet, with its shape report (file-name patterns, keys and counts; no words of his): offer it on a card whose draft is a mail from his own address to Life's developer (${DEVELOPER_CONTACT}), its text the shape report as given, its question like "Life can't read this export yet. Send its shape (no messages, no names) to Life's developer so an update can read it?"; nothing else. The import resumes by itself after an update. Anything else outward goes on a card with the exact change, and nothing leaves without his Send. Everything you write him is in plain words: never Life's internals (no file, step, tool or field names). Keep each complaint's state in your notes by its ask id, never his words; finish when every complaint you received is handled.`;

/**
 * The caretaker's `said` on assignment `s`: found (`locate`) in the words of a complaint at work there, as he said
 * them; a call with none at work there, or words not his, is refused.
 */
export function complaintWordsIn(
  { db }: Desk,
  s: Pick<AssignmentRow, "id">,
  said: string
) {
  const words = complaintsAtWork(db)
    .filter((w) => w.assignment === s.id)
    .map((w) => askOf(w.ask)?.instruction?.quote ?? "");
  const found = locate(said, words);
  if (!found) {
    throw new Error(
      "Not done: `said` must be his own words of a complaint you are fixing, verbatim (8 characters at least)."
    );
  }
  return found.verbatim;
}

/** When he last complained: a complaint's ask, anywhere in the ledger (the newest, read from the end). */
const readNewestComplaint = () => readLedger().findLast(isComplaint)?.at ?? "";

/**
 * Receives his new complaints for the caretaker: each once, in ledger order; what it could not, left for a later tick.
 * A complaint record that cannot be written holds them all (their receipts and the cursor), logged, and the tick goes on.
 */
export async function receiveComplaints(desk: Desk) {
  const { db } = desk;
  const from = Number(readCursor(db, COMPLAINTS_CURSOR) ?? 0);
  // Its page's lines only (`readLines`): a tick parses no more of the ledger than it reads.
  const rows = Array.from(
    readLines(LEDGER, from, from + ROWS_PER_TICK),
    parseLedgerEntry
  );
  const pending = rows.flatMap((a, i) =>
    a && isComplaint(a) && !complaintReceiptOf(db, a.id)
      ? [{ a, n: from + i }]
      : []
  );
  try {
    recordComplaints(pending.map((p) => p.a));
  } catch (error) {
    log("desk.complaints", { ...errorOf(error), ok: false });
    return;
  }
  // A runtime is asked only when a caretaker must be registered (a process, never inside the transaction).
  const blocked =
    pending.length > 0
      ? await roleStartBlockOf(desk, "caretaker", readNewestComplaint)
      : undefined;
  const received = db.transaction(() => {
    const to =
      pending.length > 0
        ? roleAssignmentOf(desk, "caretaker", CARETAKER_BRIEF, blocked)
        : null;
    if (to && "why" in to) {
      saveCursor(db, COMPLAINTS_CURSOR, String(pending[0]?.n ?? from));
      return null;
    }
    queue(
      db,
      COMPLAINT_RECEIVED,
      pending.map(({ a }) => ({
        assignment: to?.assignment ?? "",
        eventId: a.id,
        payload: { ask: a.id },
      }))
    );
    saveCursor(db, COMPLAINTS_CURSOR, String(from + rows.length));
    return (
      to && { asks: pending.map((p) => p.a.id), assignment: to.assignment }
    );
  })();
  if (received) {
    log("desk.complaints", received);
  }
}

/** The event id a paused import's receipt is under: its digest, so the same copy is received once, ever. */
const pausedEventIdOf = (digest: string) => `import-paused:${digest}`;

/**
 * Receives the export copies Life cannot read yet for the caretaker: each once, ever, its event id `import-paused:<digest>`
 * and its payload the source and the shape report alone (facts, never words). Blocked as a complaint is: a stopped
 * caretaker, a full desk, or a last caretaker that never started leaves it for a later tick.
 */
export async function receivePausedImports(desk: Desk) {
  const { db } = desk;
  const pending = (await pausedImportsNow()).filter(
    (p) => !caretakerReceiptOf(db, IMPORT_PAUSED, pausedEventIdOf(p.digest))
  );
  if (pending.length === 0) {
    return;
  }
  // A paused import carries no moment of its own: the newest complaint is the nearest thing to "nothing since".
  const blocked = await roleStartBlockOf(
    desk,
    "caretaker",
    readNewestComplaint
  );
  const received = db.transaction(() => {
    const to = roleAssignmentOf(desk, "caretaker", CARETAKER_BRIEF, blocked);
    if ("why" in to) {
      return null;
    }
    queue(
      db,
      IMPORT_PAUSED,
      pending.map((p) => ({
        assignment: to.assignment,
        eventId: pausedEventIdOf(p.digest),
        payload: { report: p.report, source: p.source },
      }))
    );
    return { assignment: to.assignment, sources: pending.map((p) => p.source) };
  })();
  if (received) {
    log("desk.imports", received);
  }
}

/** Complaint `ask` as its caretaker reads it through its door (`read_complaint`): only one received on assignment `s`. */
export function readComplaint(
  { db }: Desk,
  s: Pick<AssignmentRow, "id">,
  ask: string
) {
  const a =
    complaintReceiptOf(db, ask)?.assignment === s.id ? askOf(ask) : undefined;
  const c = a && complaintOf(a);
  if (!(a && c)) {
    return { error: `Not done: no complaint ${ask} was received here.` };
  }
  return {
    at: a.at,
    card: c.card,
    // An old press's: whether the card Life read was the one he saw.
    ...(c.isAsShown === undefined ? {} : { isAsShown: c.isAsShown }),
    ref: c.ref,
    report: c.report,
    words: a.instruction?.quote ?? "",
  };
}
