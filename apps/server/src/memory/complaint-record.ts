import { existsSync, readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appendJsonl } from "../core/files";
import { CheckGroup } from "../core/names";
import { isoDateTime } from "../records/fields";
import {
  complaintOf,
  isComplaint,
  type LedgerEntry,
} from "../records/ledger-entry";
import { EPISODES_PROMPT } from "./episodes";
import { LINKS_PROMPT } from "./links";
import { MATTERS_PROMPT } from "./matters";
import { MEMORY, readLedger } from "./memory-files";

// The complaint record (`memory/complaints.jsonl`): one row per complaint (his "Wrong…", an ask in the ledger), what
// the caretaker's later work and the developer's counts start from. It holds no words of his and no card: the ask's id,
// the kind of card, the stage that made it and that stage's prompt at his press. Appended only here, after the ask.

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

function rowOf(a: LedgerEntry): ComplaintRow {
  const group = CheckGroup.safeParse(
    (complaintOf(a)?.card as { group?: unknown } | null)?.group
  );
  const kind = group.success ? group.data : "unknown";
  return {
    ask: a.id,
    at: a.at,
    kind,
    ...(group.success
      ? STAGES[group.data]
      : { prompt: null, stage: "unknown" }),
    schemaVersion: 1,
  };
}

/**
 * Brings the complaint record level with the ledger: a last line cut short (a crash mid-append) is dropped first, then a
 * row is appended for each complaint that has none, in ledger order (a press whose row was lost gets it on the next).
 * A bad line before the last throws: it is shown, never rewritten. Synchronous, so nothing runs between its read and its
 * append. The rows appended.
 */
export function recordComplaints(
  ledger: readonly LedgerEntry[] = readLedger()
) {
  const text = existsSync(COMPLAINTS) ? readFileSync(COMPLAINTS, "utf8") : "";
  const end = text.lastIndexOf("\n") + 1;
  if (end < text.length) {
    truncateSync(COMPLAINTS, end);
  }
  const held = new Set(
    text
      .slice(0, end)
      .split("\n")
      .filter(Boolean)
      .map((l) => ComplaintRow.parse(JSON.parse(l)).ask)
  );
  const rows = ledger
    .filter((a) => isComplaint(a) && !held.has(a.id))
    .map(rowOf);
  appendJsonl(COMPLAINTS, ComplaintRow, rows);
  return rows;
}
