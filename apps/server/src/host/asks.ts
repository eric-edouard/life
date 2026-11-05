import { clock, iso } from "../core/clock";
import { appendJsonl, linesOf } from "../core/files";
import { AGENT_WORD } from "../core/names";
import { startDetached } from "../core/proc";
import { settings } from "../core/settings";
import { feedPage, PAGE, parseCursor } from "../memory/changes";
import { LEDGER, parseLedgerEntry, tasksOf } from "../memory/ledger";
import { clip } from "../memory/units";
import { type Instruction, LedgerEntry } from "../records/ledger-entry";
import { entryId } from "./act";

// His asks of his agents: each "hey <agent>" (`hear.ts`) or `bun life ask` is one `ask` line in memory/ledger.jsonl,
// and the agent pulls its own (`read_agent_asks`) and keeps its own list. Life keeps no state of an ask past that line
// (his word, 2 Nov 2026); the agents' updates and replies before it stay as history (`TASK_LINES`).

/**
 * Records one ask: his words, where they are (`ref`: the wake turn, the session) and `after` (`agent`, `confidence`;
 * for speech `conversation` and `turns`). The same ref asks once, and only a new ask starts the agent's `onAsk`.
 */
export function ask(
  instruction: Instruction,
  after: LedgerEntry["after"] & { agent: string },
  via: "session" | "watch",
  why: string,
  now = clock().getTime(),
  timing?: LedgerEntry["timing"]
) {
  const line = {
    after,
    at: iso(now),
    // The title part of the recipe stays, empty, so every stored id is the one this makes.
    id: entryId(instruction.ref, "ask", ""),
    // Clipped so it stays far under what a client may carry; `fetch` has the rest.
    instruction: { ...instruction, quote: clip(instruction.quote, 50_000) },
    kind: "ask",
    result: "ok",
    schemaVersion: 1,
    target: AGENT_WORD,
    via,
    ...(timing ? { timing } : {}),
    why,
  } satisfies LedgerEntry;
  const old = tasksOf().find((t) => t.ask.id === line.id)?.ask;
  if (!old) {
    appendJsonl(LEDGER, LedgerEntry, [line]);
    const onAsk = settings().agents?.[after.agent]?.onAsk;
    if (onAsk) {
      startDetached(onAsk);
    }
  }
  return old ?? line;
}

/**
 * A page of `agent`'s asks past `cursor`, in the order recorded (`read_agent_asks`): the ledger's own cursor, so an
 * ask appended late is never skipped and none comes twice.
 */
export function asksFor(agent: string, cursor?: string, limit = PAGE) {
  const page = feedPage(
    [{ lines: linesOf(LEDGER), name: "ledger" }],
    parseCursor(cursor),
    limit,
    (_, line) => {
      const a = parseLedgerEntry(line);
      return a?.kind === "ask" && a.instruction && a.after.agent === agent
        ? {
            at: a.at,
            confidence: a.after.confidence,
            id: a.id,
            quote: a.instruction.quote,
            spoke: a.instruction.at,
          }
        : null;
    }
  );
  return { asks: page.items, cursor: page.cursor, remaining: page.remaining };
}

/**
 * Where each ask's time went, in the order recorded (`bun life asks`): when he spoke, his words ended, lifelog's feed
 * had all of them, Life recorded the ask; null where unknown (not speech, or before 20 Oct). An old split's parts are
 * left out: they share their parent's times.
 */
export function timings(from = "", to = "9999", tasks = tasksOf()) {
  return tasks
    .filter((t) => !t.ask.after.parent && t.ask.at >= from && t.ask.at < to)
    .map(({ ask: a }) => ({
      id: a.id,
      // In order (an array: the formatter sorts object keys).
      instants: [
        ["spoke", a.instruction.at],
        ["ended", a.timing?.ended ?? null],
        ["arrived", a.timing?.arrived ?? null],
        ["recorded", a.at],
      ] as [string, string | null][],
      quote: a.instruction.quote,
      via: a.via,
    }));
}
