import {
  type ChapterTurn,
  readTranscript,
  type Store,
  speechSeconds,
  turnRef,
  turnsBetween,
} from "./sources/lifelog";
import { ask } from "./tasks";
import { TEST } from "./truth";

// Hears "hey Atlas" in his recorded speech and records each ask for Atlas (`ask`, delivered by the watcher as an MCP
// event). No model call: the two words wake it, his turns that follow are the ask, and Atlas judges the rest.

/**
 * "hey Atlas" as lifelog may write it (`LIFE_MISHEARD` in `.env`): a real name people he knows go
 * by, so that one wakes only on his own turn, as `low` (Atlas confirms with him first).
 */
const MISHEARD = (TEST ? "Zorba" : process.env.LIFE_MISHEARD)?.trim();
/** "hey" then Atlas or its misheard word, whatever the case and the punctuation around or between them. */
export const WAKE = new RegExp(
  String.raw`\bhey\W+(atlas${MISHEARD ? `|${RegExp.escape(MISHEARD)}` : ""})\b`,
  "i"
);
/** A pause longer than this between two of his turns (one's end to the next's start) closes the ask. */
const GAP_MS = 15_000;
/** lifelog closes a recording of less speech than this only after 30 s without speech (its cutter.ts), more than GAP_MS. */
export const CLOSED_ON_SILENCE_S = 60;
/** How long a wake with no speaker waits for lifelog to name him (70% of recordings within 10 s, 5% more by 40 s). */
const NAMING_MS = 40_000;

/** How sure a turn's wake is: his "hey Atlas" high, an unattributed one or his misheard one low; else none. */
function wakeOf(t: Turn) {
  const words = [...t.text.matchAll(new RegExp(WAKE, "gi"))].map((m) =>
    m[1]?.toLowerCase()
  );
  if (words.includes("atlas") && t.who !== "other") {
    return t.who === "me" ? "high" : "low";
  }
  return words.length > 0 && t.who === "me" ? "low" : undefined;
}

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
 * another speaker, a 15 s pause or a new wake. Its confidence is `wakeOf`'s.
 */
export function asksIn(turns: Turn[], from: string) {
  return turns.flatMap((t, i) => {
    const confidence = wakeOf(t);
    if (t.at < from || !confidence) {
      return [];
    }
    const rest = turns.slice(i + 1);
    const cut = rest.findIndex(
      (n, k) =>
        n.who !== t.who ||
        wakeOf(n) ||
        Date.parse(n.at) - Date.parse((rest[k - 1] ?? t).end) > GAP_MS
    );
    const span = turns.slice(i, cut < 0 ? turns.length : i + 1 + cut);
    return [
      {
        at: t.at,
        confidence,
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
 * Where a conversation's speech from `from` on stands for hearing: `complete` once its last turn is someone else's or
 * ends a recording lifelog closed on silence (no turn of an ask can follow), else `open` (the next recording may go
 * on with it).
 */
export function speechIn(store: Store, conversation: string, from: string) {
  const last = turnsBetween(store, conversation, from).at(-1);
  if (!last || whose(last) === "other") {
    return "complete";
  }
  const seconds = speechSeconds(store, last.jobId);
  // lifelog sends 0 for a recording it could not measure: unknown, like a missing one.
  return seconds && seconds < CLOSED_ON_SILENCE_S ? "complete" : "open";
}

/**
 * Hears one conversation from `from` on and records its asks, except a wake with no speaker younger than NAMING_MS
 * (lifelog may still name him: a `low` ask stays low): false while one is held. The words are fetched from lifelog; a
 * failed fetch throws (the watcher hears the conversation again), never reads as silence.
 */
export async function hear(
  store: Store,
  conversation: string,
  from: string,
  now = Date.now()
) {
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
  // A wake with no speaker, younger than NAMING_MS: held, so lifelog can still name him.
  const held = (a: { timing: { arrived: string }; turns: number[] }) =>
    turns[a.turns[0] ?? -1]?.who === "unknown" &&
    now - Date.parse(a.timing.arrived) < NAMING_MS;
  const asks = asksIn(turns, from);
  for (const a of asks.filter((x) => !held(x))) {
    ask(
      { at: a.at, quote: a.quote, ref: a.ref },
      { confidence: a.confidence, conversation, turns: a.turns },
      "watch",
      "heard its wake",
      now,
      a.timing
    );
  }
  return !asks.some(held);
}
