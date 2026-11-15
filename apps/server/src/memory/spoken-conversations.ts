import { CONVERSATION_ENDS_AFTER } from "../core/quiet";
import { type LifelogTurn, turnRef, voiceKey } from "../sources/lifelog";
import { exchangesOf, isFinished } from "./exchanges";
import { OWNER } from "./read-truth";
import { turnKey, UNKNOWN } from "./units";
import type { People } from "./who";
import { messageLine, talksWithOwner, turnLines } from "./words";
import { localDate, time } from "./zones";

// The spoken conversations (docs/glossary.md): the owner's recorded speech cut where nobody speaks for
// `CONVERSATION_ENDS_AFTER`, whoever was there, and the parts a long one is read in. Cut by code from lifelog's turns
// (their words fetched when read), never stored.

/** A conversation of at least this many characters, with someone else talking, gets a summary. */
export const SUMMARY_FROM_CHARS = 15_000;
/** A part holds at most this many characters: a longer conversation is cut at its longest silence. */
export const CONVERSATION_PART_CHARS = 150_000;

/** A recorded turn and the lifelog conversation it is in (`readSpokenTurns`). */
export type SpokenTurn = LifelogTurn & { conversation: string };

/** The spoken conversations among `turns` that are over as of `now` (`isFinished`), oldest first. */
export const spokenConversationsOf = (turns: SpokenTurn[], now: Date) =>
  exchangesOf(turns, CONVERSATION_ENDS_AFTER).filter((c) =>
    isFinished(c, now, CONVERSATION_ENDS_AFTER)
  );

/** One call's worth of a conversation: its lines `[n] HH:MM who: text` from 0, and the key of each turn they are. */
export interface SpokenPart {
  at: string;
  chars: number;
  day: string;
  keys: string[];
  lines: string[];
  /** The named people (other than him) whose turns are in it, by name. */
  people: string[];
  /** Its first turn's ref: what opens it (`fetch person:me/conversation/<ref>`). */
  ref: string;
}

/** The end of each part of lines of these `sizes` and the `gaps` of silence before each line: the longest silence in the part's second half, else the longest anywhere in it. */
function cutsOf(sizes: number[], gaps: number[]) {
  const ends: number[] = [];
  let from = 0;
  while (from < sizes.length) {
    let size = 0;
    let [best, any] = [-1, -1];
    let i = from;
    for (
      ;
      i < sizes.length && size + (sizes[i] ?? 0) <= CONVERSATION_PART_CHARS;
      i += 1
    ) {
      if (i > from) {
        if (any < 0 || (gaps[i] ?? 0) > (gaps[any] ?? 0)) {
          any = i;
        }
        if (
          size >= CONVERSATION_PART_CHARS / 2 &&
          (best < 0 || (gaps[i] ?? 0) > (gaps[best] ?? 0))
        ) {
          best = i;
        }
      }
      size += sizes[i] ?? 0;
    }
    const to = i >= sizes.length ? sizes.length : Math.max(best, any, from + 1);
    ends.push(to);
    from = to;
  }
  return ends;
}

/**
 * The parts a spoken conversation is read in, or none when it does not qualify (under `SUMMARY_FROM_CHARS`, or no
 * line but his). Its words are fetched from lifelog (`turnLines`): a voice lifelog heard from a screen, nearby or as an
 * announcement is left out, one it never classified or heard over a phone is kept. A voice no one named is `V1`, `V2`… by its
 * first line (distinct per recording and label); a failed fetch throws.
 */
export async function spokenPartsOf(
  conversation: SpokenTurn[],
  people: Pick<People, "nameOf" | "resolve">
): Promise<SpokenPart[]> {
  const byRef = new Map(
    conversation.map((t) => [turnRef(t.jobId, t.turnIndex, t.at), t])
  );
  const spoken = await turnLines(
    new Map([["c", conversation]]),
    [...new Set(conversation.map((t) => t.conversation))],
    people.resolve,
    (kind) => !kind || talksWithOwner(kind)
  );
  const voices = new Map<string, string>();
  let silent = Number.NEGATIVE_INFINITY;
  const shown = (spoken.get("c") ?? []).flatMap((l) => {
    const t = byRef.get(l.ref);
    if (!t) {
      return [];
    }
    let who = "me";
    if (!t.owner && t.name) {
      who = people.nameOf(l.speaker);
    } else if (!t.owner) {
      const key = voiceKey(t.jobId, l.speaker.slice(UNKNOWN.length));
      who = voices.get(key) ?? `V${voices.size + 1}`;
      voices.set(key, who);
    }
    const gap = Date.parse(t.at) - silent;
    silent = Math.max(silent, Date.parse(t.end ?? t.at));
    const text = messageLine(time(t.at), who, l.text);
    return [
      {
        gap,
        key: turnKey(t),
        named: !t.owner && !!t.name && who,
        ref: l.ref,
        size: text.length + 1,
        speaker: l.speaker,
        t,
        text,
      },
    ];
  });
  const chars = shown.reduce((n, s) => n + s.size, 0);
  if (chars < SUMMARY_FROM_CHARS || shown.every((s) => s.speaker === OWNER)) {
    return [];
  }
  let from = 0;
  return cutsOf(
    shown.map((s) => s.size),
    shown.map((s) => s.gap)
  ).map((to) => {
    const part = shown.slice(from, to);
    from = to;
    const [first] = part;
    return {
      at: first?.t.at ?? "",
      chars: part.reduce((n, s) => n + s.size, 0),
      day: localDate(first?.t.at ?? ""),
      keys: part.map((s) => s.key),
      lines: part.map((s, n) => `[${n}] ${s.text}`),
      people: [...new Set(part.flatMap((s) => s.named || []))],
      ref: first?.ref ?? "",
    };
  });
}
