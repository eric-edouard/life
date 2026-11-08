import { clock } from "../core/clock";
import { asHeard, LIFE_WAKE, type Settings, settings } from "../core/settings";
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
import { ask } from "./asks";

// Hears "hey <word>" in his recorded speech: his turns that follow are a span. Every span is recorded in the store as a
// mark (`writeMarks`): Life keeps what he says to it. A span woken by an agent's word is also an ask for that agent
// (`ask`; the agent pulls it, `read_agent_asks`); "hey Life" (`LIFE_WAKE`) wakes none. No model call: the two words
// wake it, and the agent judges the rest.

const SPACES = /\s+/;
/** One wake word as lifelog may write it: its words, with any spaces or punctuation between them. */
const phrase = (w: string) =>
  w.trim().split(SPACES).map(RegExp.escape).join(String.raw`\W+`);
/**
 * "hey" as lifelog writes it, then the spaces and punctuation after it: "Hej" on 21 Oct (audit 4), never the end of a
 * longer word. Shared by both wakes.
 */
const GREETING = String.raw`\b(?:hey|hej|hei|hé|ey)\W+`;
let made: { of: unknown; wakes: ReturnType<typeof wakesOf> } | undefined;
/** The wakes of this process: Life's own and its agents' (made once per settings read). */
export function wakes() {
  const { agents } = settings();
  const m =
    made && made.of === agents
      ? made
      : { of: agents, wakes: wakesOf(agents ?? {}) };
  made = m;
  return m.wakes;
}
function wakesOf(agents: NonNullable<Settings["agents"]>) {
  // Life's own wake first, with no agent.
  const all: [string | undefined, typeof LIFE_WAKE][] = [
    [undefined, LIFE_WAKE],
    ...Object.entries(agents),
  ];
  type Word = [string, { agent?: string; isName: boolean }];
  /** Each word as heard, to its agent (none for Life's own); and whether it is a name, not a mishearing. */
  const words = new Map<string, { agent?: string; isName: boolean }>(
    all.flatMap(([agent, a]) => [
      ...a.misheard.map((w): Word => [asHeard(w), { agent, isName: false }]),
      ...a.wake.map((w): Word => [asHeard(w), { agent, isName: true }]),
    ])
  );
  const any = all.flatMap(([, a]) => [...a.wake, ...a.misheard]).map(phrase);
  /** A greeting then Life's name, an agent's or a mishearing of one, whatever the case. */
  const wake = new RegExp(String.raw`${GREETING}(${any.join("|")})\b`, "i");
  return {
    /** The agent a wake word wakes; none for Life's own. */
    agentOf: (word: string) => words.get(asHeard(word))?.agent,
    /**
     * Whether a wake word is an agent's name, not a mishearing (the `misheard` setting: a mishearing lifelog made on
     * 20 Oct, audit 4, or a real name people he knows go by). A misheard one wakes only on his own turn, as `low` (the
     * agent confirms with him).
     */
    isName: (word: string) => words.get(asHeard(word))?.isName === true,
    /** Everything up to "hey <agent>" and the spaces and punctuation after it: the title is his words from there. */
    toWake: new RegExp(String.raw`^.*?${wake.source}[\s\p{P}]*`, "isu"),
    wake,
  };
}
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

/** The wake words in a turn: Life's name, an agent's, or a misheard one. */
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
 * wake. Its confidence is `wakeOf`'s; its agent, the one its first wake word wakes (none for "hey Life": a mark only).
 */
export function spansIn(turns: Turn[], from: string) {
  return turns.flatMap((t, i) => {
    const confidence = wakeOf(t);
    // The turn's first wake word names its agent, or Life's own.
    const agent = wakes().agentOf(wakeWords(t)[0] ?? "");
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
  for (const a of spans.flatMap((x) =>
    x.agent && !held(x) ? [{ ...x, agent: x.agent }] : []
  )) {
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
