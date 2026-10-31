import { clock } from "../core/clock";
import { wakes } from "../memory/tasks";
import {
  endedOnSilence,
  isConversationClosed,
  readTranscript,
  type Store,
  turnRef,
  turnsBetween,
  whose,
  writeMarks,
} from "../sources/lifelog";
import { ask } from "./agent";

// Hears "hey <agent>" in his recorded speech and records each ask for the agent (`ask`, which starts the agent at the watcher's
// next minute). No model call: the two words wake it, his turns that follow are the ask, and the agent judges the rest. Each
// ask's span is also recorded in the store as a mark (`writeMarks`): what he asks is worth remembering.

/** A pause longer than this between two of his turns (one's end to the next's start) closes the ask. */
const GAP_MS = 15_000;
/** How long a wake with no speaker waits for lifelog to name him (70% of recordings within 10 s, 5% more by 40 s). */
const NAMING_MS = 40_000;

type Confidence = "high" | "low";

/** How sure a turn's wake is: his "hey <agent>" high, an unattributed one or his misheard one low; else none. */
function wakeOf(t: Turn): Confidence | undefined {
  const words = wakeWords(t);
  if (words.some((w) => wakes().isName(w)) && t.who !== "other") {
    return t.who === "me" ? "high" : "low";
  }
  return words.length > 0 && t.who === "me" ? "low" : undefined;
}

/** The wake words in a turn: an agent's name, or a misheard one. */
const wakeWords = (t: Turn) =>
  [...t.text.matchAll(new RegExp(wakes().wake, "gi"))].flatMap((m) =>
    m[1] ? [m[1]] : []
  );

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
 * after `from`: a wake turn, then the following turns of the same speaker until another speaker, a 15 s pause or a new
 * wake. Its confidence is `wakeOf`'s; its agent, the one its first wake word wakes.
 */
export function asksIn(turns: Turn[], from: string) {
  return turns.flatMap((t, i) => {
    const confidence = wakeOf(t);
    // The turn's first wake word names its agent (every word the wake matches is one of an agent's).
    const agent = wakes().agentOf(wakeWords(t)[0] ?? "");
    if (t.at < from || !confidence || !agent) {
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
        agent,
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

/**
 * Where a conversation's speech from `from` on stands for hearing: `complete` once its last turn is someone else's,
 * ends a recording nobody spoke after for 30 s (`endedOnSilence`), or lifelog has settled the conversation (`closed`):
 * lifelog's own signals, never a timing rule of Life's. Else `open` (the next recording may go on with it).
 */
export function speechIn(store: Store, conversation: string, from: string) {
  const last = turnsBetween(store, conversation, from).at(-1);
  if (!last || whose(last) === "other") {
    return "complete";
  }
  return endedOnSilence(store, last.jobId) ||
    isConversationClosed(store, conversation)
    ? "complete"
    : "open";
}

/**
 * Hears one conversation from `from` on and records its asks, except a wake with no speaker younger than NAMING_MS
 * (lifelog may still name him: a `low` ask stays low): `heard` false while one is held; `marked` when its marks
 * (its asks' spans) changed. The words are fetched from lifelog; a
 * failed fetch throws (the watcher hears the conversation again), never reads as silence.
 */
export async function hear(
  store: Store,
  conversation: string,
  from: string,
  now = clock().getTime()
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
      {
        agent: a.agent,
        confidence: a.confidence,
        conversation,
        turns: a.turns,
      },
      "watch",
      "heard its wake",
      now,
      a.timing
    );
  }
  // Each ask's span, held ones too, is a mark: its unit carries it, read again at importance 3 (units.ts, moments.ts).
  const marked = writeMarks(
    store,
    conversation,
    from,
    asks.map((a) => a.turns.flatMap((i) => turns[i]?.ref ?? []))
  );
  // His misheard wake is an ask only once lifelog names him: a turn with no speaker yet waits too.
  const misheard = turns.some(
    (t) =>
      t.who === "unknown" &&
      wakeWords(t).some((w) => !wakes().isName(w)) &&
      now - Date.parse(t.seen) < NAMING_MS
  );
  return { heard: !(asks.some(held) || misheard), marked };
}
