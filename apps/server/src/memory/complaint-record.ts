import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appendJsonl, readAppended } from "../core/files";
import { CheckGroup } from "../core/names";
import { isoDateTime } from "../records/fields";
import { complaintOf, type LedgerEntry } from "../records/ledger-entry";
import { EPISODES_PROMPT } from "./episodes";
import { LINKS_PROMPT } from "./links";
import { MATTERS_PROMPT } from "./matters";
import { MEMORY } from "./memory-files";

// The complaint record (`memory/complaints.jsonl`): one row per complaint (his "Wrong…", an ask in the ledger), what
// the caretaker's later work and the developer's counts start from. It holds no words of his and no card: the ask's id,
// the kind of card, the stage that made it and that stage's prompt, as his press froze them in the ask. Appended only
// here, by the desk as it receives a complaint (`desk/complaint-intake.ts`): one process (one desk per Mac), each tick
// one at a time, only for the complaints it is receiving, so its recording and its recovery after a crash are the same
// pass, before the receipt.

export const COMPLAINTS = join(MEMORY, "complaints.jsonl");

/** The stage that makes each kind of Life's card, and its prompt when a model's: where a complaint about it points. */
const STAGES: Record<CheckGroup, { prompt: string | null; stage: string }> = {
  "contacts card": { prompt: null, stage: "contacts" },
  // An agent's card takes no complaint; a row of one would be a bug's.
  decision: { prompt: null, stage: "unknown" },
  ending: { prompt: LINKS_PROMPT, stage: "links" },
  "guessed person": { prompt: EPISODES_PROMPT, stage: "episodes" },
  name: { prompt: null, stage: "names" },
  "new matter": { prompt: MATTERS_PROMPT, stage: "matters" },
  voice: { prompt: null, stage: "voice naming" },
};

export const ComplaintRow = z
  .object({
    ask: z.string(),
    at: isoDateTime,
    /** The card's kind; `unknown` when it had left before his press. */
    kind: z.union([CheckGroup, z.literal("unknown")]),
    prompt: z.string().nullable(),
    schemaVersion: z.literal(1),
    stage: z.string(),
  })
  .strict();
export type ComplaintRow = z.infer<typeof ComplaintRow>;

/** Card `card`'s kind, the stage that made it and that stage's prompt now: frozen into his complaint at his press. */
export function stageOf(card: unknown) {
  const group = CheckGroup.safeParse(
    (card as { group?: unknown } | null)?.group
  );
  return group.success
    ? { kind: group.data, ...STAGES[group.data] }
    : { kind: "unknown" as const, prompt: null, stage: "unknown" };
}

/** The row of complaint `a`, from what its ask froze at his press. */
function rowOf(a: LedgerEntry): ComplaintRow {
  const c = complaintOf(a);
  const kind = CheckGroup.safeParse(c?.kind);
  return {
    ask: a.id,
    at: a.at,
    kind: kind.success ? kind.data : "unknown",
    prompt: c?.prompt ?? null,
    schemaVersion: 1,
    stage: c?.stage ?? "unknown",
  };
}

/** The asks the complaint record holds a row for (one fold per process: only new lines are parsed). */
const readRecorded = () =>
  readAppended<ComplaintRow, Set<string>>(
    COMPLAINTS,
    ComplaintRow,
    (last) => new Set(last),
    (held, r) => {
      held.add(r.ask);
    }
  );

/**
 * Ends the record on a whole line before an append. Only its last byte is read, unless a crash left its last line
 * unterminated: cut short (no JSON), it is dropped; a whole row, it is ended; whole JSON that is not a row throws, its
 * bytes kept, shown and never rewritten.
 */
function mendTail() {
  const size = statSync(COMPLAINTS, { throwIfNoEntry: false })?.size ?? 0;
  const last = Buffer.alloc(1);
  if (size > 0) {
    const fd = openSync(COMPLAINTS, "r");
    try {
      readSync(fd, last, 0, 1, size - 1);
    } finally {
      closeSync(fd);
    }
  }
  if (size === 0 || last[0] === 10) {
    return;
  }
  const text = readFileSync(COMPLAINTS, "utf8");
  const end = text.lastIndexOf("\n") + 1;
  let tail: unknown;
  try {
    tail = JSON.parse(text.slice(end));
  } catch {
    truncateSync(COMPLAINTS, end);
    return;
  }
  ComplaintRow.parse(tail);
  appendFileSync(COMPLAINTS, "\n");
}

/**
 * Writes the complaint record's row for each of `asks` (complaints) that has none, in order: the intake's pending ones,
 * so a crash after an ask is recovered by the next tick with no second press. Synchronous, so nothing runs between its
 * read and its append; a bad row throws before anything is appended. The rows appended.
 */
export function recordComplaints(asks: readonly LedgerEntry[]) {
  mendTail();
  const held = readRecorded();
  const added = asks.filter((a) => !held.has(a.id)).map(rowOf);
  appendJsonl(COMPLAINTS, ComplaintRow, added);
  return added;
}
