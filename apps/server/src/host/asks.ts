import { clock, iso } from "../core/clock";
import { appendJsonl } from "../core/files";
import { AGENT_WORD } from "../core/names";
import { feedPage, fileSource, PAGE, parseCursor } from "../memory/changes";
import {
  askOf,
  LEDGER,
  parseLedgerEntry,
  tasksOf,
} from "../memory/memory-files";
import { clip } from "../memory/units";
import {
  type Instruction,
  isComplaint,
  isSpokenAsk,
  LedgerEntry,
} from "../records/ledger-entry";
import { entryId } from "./change-todo-item";

// His asks of the desk (the built-in agent `desk`, `DESK_AGENT`): each "hey Life" (`hear.ts`, a spoken ask), his word
// about a registered agent (`change_registered_agent`) and his complaint is one `ask` line in memory/ledger.jsonl, which
// the desk reads itself (`desk/agent-changes.ts`, `desk/spoken-ask-intake.ts`, `desk/complaint-intake.ts`). The rest
// of Life keeps no state of an ask past that line (his word, 2 Nov 2026); the agents' updates and replies before it stay
// as history (`TASK_LINES`).

/**
 * Records one ask: his words, where they are (`ref`: the wake turn, the session) and `after` (`agent`, `confidence`;
 * for speech `conversation` and `turns`). The same ref asks once.
 */
export function ask(
  instruction: Instruction,
  after: LedgerEntry["after"] & { agent: string },
  via: "connector" | "watch",
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
  const old = askOf(line.id);
  if (!old) {
    appendJsonl(LEDGER, LedgerEntry, [line]);
  }
  return old ?? line;
}

/**
 * A page of `agent`'s asks past `cursor`, in the order recorded (the desk's changes): the ledger's own cursor, so an
 * ask appended late is never skipped and none comes twice. His complaints and spoken asks are never pulled: the desk
 * reads them itself.
 */
export function asksFor(agent: string, cursor?: string, limit = PAGE) {
  const page = feedPage(
    [fileSource(LEDGER, "ledger")],
    parseCursor(cursor),
    limit,
    (_, line) => {
      const a = parseLedgerEntry(line);
      return a?.kind === "ask" &&
        a.instruction &&
        a.after.agent === agent &&
        !isComplaint(a) &&
        !isSpokenAsk(a)
        ? {
            agentChange: a.after.agentChange,
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
 * Where each ask's time went, in the order recorded (`bun life asks`): when he spoke, his words ended, the voice server's feed
 * had all of them, Life recorded the ask; null where unknown (not speech, or before 20 Oct). An old split's parts are
 * left out (they share their parent's times), and his complaints (`isComplaint`).
 */
export function timings(from = "", to = "9999", tasks = tasksOf()) {
  return tasks
    .filter(
      (t) =>
        !(t.ask.after.parent || isComplaint(t.ask)) &&
        t.ask.at >= from &&
        t.ask.at < to
    )
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
