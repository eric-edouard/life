import {
  type ChapterTurn,
  readTranscript,
  type Store,
  speechSeconds,
  turnRef,
  turnsBetween,
} from "./sources/lifelog";
import { ask } from "./tasks";

// Hears "hey Atlas" in his recorded speech and records each ask for Atlas (`ask`, delivered by the watcher as an MCP
// event). No model call: the two words wake it, his turns that follow are the ask, and Atlas judges the rest.

/** The two words in this order, whatever the case and the punctuation around or between them. */
export const WAKE = /\bhey\W+atlas\b/i;
/** A pause longer than this between two of his turns (one's end to the next's start) closes the ask. */
const GAP_MS = 15_000;
/** lifelog closes a recording of less speech than this only after 30 s without speech (its cutter.ts), more than GAP_MS. */
const CLOSED_ON_SILENCE_S = 60;

export const wakes = (text: string) => WAKE.test(text);

/** One turn as the hearing sees it: whose it is (his, unattributed, someone else's) and its words. */
export interface Turn {
  at: string;
  /** When it ended, and when lifelog's feed first brought it (both `at` on a turn stored before 20 Oct). */
  end: string;
  ref: string;
  seen: string;
  text: string;
  who: "me" | "unknown" | "other";
}

/**
 * The asks in a conversation's turns (all of them, in order, so the indexes are `fetch --from-turn`'s), woken at or
 * after `from`. An ask is a wake turn that is not someone else's, then the following turns of the same speaker until
 * another speaker, a 15 s pause or a new wake. His wake is `high` confidence, an unattributed one `low`.
 */
export function asksIn(turns: Turn[], from: string) {
  return turns.flatMap((t, i) => {
    if (t.at < from || t.who === "other" || !wakes(t.text)) {
      return [];
    }
    const rest = turns.slice(i + 1);
    const cut = rest.findIndex(
      (n, k) =>
        n.who !== t.who ||
        wakes(n.text) ||
        Date.parse(n.at) - Date.parse((rest[k - 1] ?? t).end) > GAP_MS
    );
    const span = turns.slice(i, cut < 0 ? turns.length : i + 1 + cut);
    return [
      {
        at: t.at,
        confidence: t.who === "me" ? "high" : "low",
        quote: span.map((s) => s.text.trim()).join(" "),
        ref: t.ref,
        timing: {
          arrived: span.reduce((a, s) => (s.seen > a ? s.seen : a), t.seen),
          ended: (span.at(-1) ?? t).end,
        },
        turns: span.map((_, k) => i + k),
      },
    ];
  });
}

/** Whose a turn is, as the watcher's feed reads it (`poll`): his, someone lifelog named (by id or name), or nobody's. */
export function whose(t: ChapterTurn): Turn["who"] {
  if (t.owner) {
    return "me";
  }
  return t.personId || t.name ? "other" : "unknown";
}

/**
 * Where a conversation's speech from `from` on stands for hearing: `unnamed` while a turn has no speaker yet (lifelog
 * names him a moment after the words), `complete` once its last turn is someone else's or ends a recording lifelog
 * closed on silence (no turn of an ask can follow), else `open` (the next recording may go on with it).
 */
export function speechIn(store: Store, conversation: string, from: string) {
  const turns = turnsBetween(store, conversation, from);
  if (turns.some((t) => whose(t) === "unknown")) {
    return "unnamed";
  }
  const last = turns.at(-1);
  if (!last || whose(last) === "other") {
    return "complete";
  }
  const seconds = speechSeconds(store, last.jobId);
  return seconds !== null && seconds < CLOSED_ON_SILENCE_S
    ? "complete"
    : "open";
}

/**
 * Hears one conversation from `from` on and records its asks. The words are fetched from lifelog; a failed fetch
 * throws (the watcher hears the conversation again), never reads as silence.
 */
export async function hear(store: Store, conversation: string, from: string) {
  const all = turnsBetween(store, conversation);
  const jobs = [
    ...new Set(all.filter((t) => t.at >= from).map((t) => t.jobId)),
  ];
  const words = new Map(
    await Promise.all(
      jobs.map(async (job) => [job, await readTranscript(job)] as const)
    )
  );
  const turns = all.map(
    (t): Turn => ({
      at: t.at,
      end: t.end ?? t.at,
      ref: turnRef(t.jobId, t.turnIndex, t.at),
      seen: t.seen ?? t.at,
      text: words.get(t.jobId)?.[t.turnIndex]?.text ?? "",
      who: whose(t),
    })
  );
  for (const a of asksIn(turns, from)) {
    ask(
      { at: a.at, quote: a.quote, ref: a.ref },
      { confidence: a.confidence, conversation, turns: a.turns },
      "watch",
      "heard “hey Atlas”",
      Date.now(),
      a.timing
    );
  }
}
