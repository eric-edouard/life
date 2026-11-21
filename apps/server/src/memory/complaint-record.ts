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
import { LINKS_PROMPT } from "./links";
import { MATTERS_PROMPT } from "./matters";
import { MEMORY, readInferred } from "./memory-files";

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
  // Its prompt is the guess's own (`guessPromptOf`), never the episodes prompt now.
  "guessed person": { prompt: null, stage: "episodes" },
  name: { prompt: null, stage: "names" },
  "new matter": { prompt: MATTERS_PROMPT, stage: "matters" },
  "same person": { prompt: null, stage: "names" },
  voice: { prompt: null, stage: "voice naming" },
  "your move": { prompt: MATTERS_PROMPT, stage: "matters" },
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

/** The prompt the guess about who `ref` is was made with (its latest record's `madeBy`, as the card reads it), or `unknown`. */
const guessPromptOf = (ref: unknown) =>
  readInferred().findLast((p) => `person:${p.id}` === ref)?.madeBy.prompt ??
  "unknown";

/** Card `card`'s kind, the stage that made it and the prompt it was made with: frozen into his complaint at his press. */
export function stageOf(card: unknown) {
  const c = card as { group?: unknown; ref?: unknown } | null;
  const group = CheckGroup.safeParse(c?.group);
  if (!group.success) {
    return { kind: "unknown" as const, prompt: null, stage: "unknown" };
  }
  const stage = STAGES[group.data];
  return group.data === "guessed person"
    ? { kind: group.data, ...stage, prompt: guessPromptOf(c?.ref) }
    : { kind: group.data, ...stage };
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
 * unterminated: cut short (no JSON), it is dropped, at its byte offset; a whole row, it is ended; whole JSON that is
 * not a row throws, its bytes kept, shown and never rewritten.
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
  const bytes = readFileSync(COMPLAINTS);
  const end = bytes.lastIndexOf(10) + 1;
  let tail: unknown;
  try {
    tail = JSON.parse(bytes.subarray(end).toString("utf8"));
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
  // Every whole row is read first (a bad one throws), so the tail is mended only behind rows that hold.
  readRecorded();
  mendTail();
  const held = readRecorded();
  const added = asks.filter((a) => !held.has(a.id)).map(rowOf);
  appendJsonl(COMPLAINTS, ComplaintRow, added);
  return added;
}
