import { clock } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import {
  readTranscript,
  type Store,
  turnRef,
  turnsBetween,
  whose,
  writeMarks,
} from "../sources/lifelog";
import { isSettledAfter } from "../sources/lifelog-speech";
import { ask } from "./asks";

// Hears "hey Life" in his recorded speech: his turns that follow are a span. Every span is recorded in the store as a
// mark (`writeMarks`): Life keeps what he says to it. Every span is also an ask of the desk (`ask`), which routes it to
// one agent (`desk/spoken-ask-intake.ts`). No model call: the two words wake it, and the agent judges the rest.

const SPACES = /\s+/;
const NON_WORD = /\W+/g;
/** One wake word as lifelog may write it: its words, with any spaces or punctuation between them. */
const phrase = (w: string) =>
  w.trim().split(SPACES).map(RegExp.escape).join(String.raw`\W+`);
/**
 * "hey" as lifelog writes it, then the spaces and punctuation after it: "Hej" on 21 Oct (audit 4), never the end of a
 * longer word.
 */
const GREETING = String.raw`\b(?:hey|hej|hei|hé|ey)\W+`;
/** Life's wake ("hey Life"); "live" is how lifelog wrote it on 21 Oct (audit 4): a mishearing, low confidence. */
const LIFE_WAKE = { misheard: ["live"], wake: ["life"] };
/** A wake word as heard, compared: lower case, one space between words. */
const asHeard = (w: string) => w.toLowerCase().replace(NON_WORD, " ").trim();
const NAMES = new Set(LIFE_WAKE.wake.map(asHeard));
/** A greeting then Life's name or a mishearing of it, whatever the case. */
const WAKE = new RegExp(
  String.raw`${GREETING}(${[...LIFE_WAKE.wake, ...LIFE_WAKE.misheard].map(phrase).join("|")})\b`,
  "i"
);
/** Life's wake: the pattern, and whether a wake word is its name, not a mishearing (a misheard one wakes only on his own turn, as `low`). */
export const wakes = () => ({
  isName: (word: string) => NAMES.has(asHeard(word)),
  wake: WAKE,
});
/** A pause longer than this between two of his turns (one's end to the next's start) closes the ask. */
const GAP_MS = 15_000;
/** How long a wake with no speaker waits for lifelog to name him (70% of recordings within 10 s, 5% more by 40 s). */
const NAMING_MS = 40_000;

type Confidence = "high" | "low";

/** How sure a turn's wake is: his "hey Life" high, an unattributed one or his misheard one low; else none. */
function wakeOf(t: Turn): Confidence | undefined {
  const words = wakeWords(t);
  if (words.some((w) => wakes().isName(w)) && t.who !== "other") {
    return t.who === "me" ? "high" : "low";
  }
  return words.length > 0 && t.who === "me" ? "low" : undefined;
}

/** The wake words in a turn: Life's name or a misheard one. */
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
 * The spans in a conversation's turns (all of them, in order, so the indexes are `fetch --from-turn`'s), woken at or
 * after `from`: a wake turn, then the following turns of the same speaker until another speaker, a 15 s pause or a new
 * wake. Its confidence is `wakeOf`'s.
 */
export function spansIn(turns: Turn[], from: string) {
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

/**
 * Where a conversation's speech from `from` on stands for hearing: `complete` once its last turn is someone else's,
 * ends a recording nobody spoke after (`endedOnSilence`), or lifelog has settled the conversation (`closed`), as `isSettledAfter` has it:
 * lifelog's own signals, never a timing rule of Life's. Else `open` (the next recording may go on with it).
 */
export function speechIn(store: Store, conversation: string, from: string) {
  const last = turnsBetween(store, conversation, from).at(-1);
  if (!last || whose(last) === "other") {
    return "complete";
  }
  return isSettledAfter(store, { conversation, jobId: last.jobId })
    ? "complete"
    : "open";
}

/**
 * Hears one conversation from `from` on and records its marks and asks, except an ask whose wake has no speaker and is
 * younger than NAMING_MS (lifelog may still name him: a `low` ask stays low): `heard` false while one is held; `marked`
 * when its marks (its spans) changed. The words are fetched from lifelog; a
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
  const spans = spansIn(turns, from);
  for (const a of spans.filter((x) => !held(x))) {
    ask(
      { at: a.at, quote: a.quote, ref: a.ref },
      {
        agent: DESK_AGENT,
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
  // Each span, held ones too, is a mark: its unit carries it and is always read (units.ts, episodes.ts).
  const marked = writeMarks(
    store,
    conversation,
    from,
    spans.map((a) => a.turns.flatMap((i) => turns[i]?.ref ?? []))
  );
  // His misheard wake is an ask only once lifelog names him: a turn with no speaker yet waits too.
  const misheard = turns.some(
    (t) =>
      t.who === "unknown" &&
      wakeWords(t).some((w) => !wakes().isName(w)) &&
      now - Date.parse(t.seen) < NAMING_MS
  );
  return { heard: !(spans.some(held) || misheard), marked };
}
