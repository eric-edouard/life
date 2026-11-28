import { iso } from "../core/clock";
import type { Unit } from "../records/unit";
import { type LifelogTurn, turnRef } from "../sources/voice-server";
import { readTurnClip } from "../sources/voice-speakers";
import { type Deletions, isCut, isGone } from "./deletions";

// A recording read cut to a span of instants, such as a call's exact one (`fetch`'s `at` and `until`, life#875): the
// turns that overlap it (`turnsOverlapping`), a turn crossing an edge kept to its words wholly inside.

/** A span of instants (ISO, `until` exclusive) a recording is cut to: a call's `at` and `until`. */
export interface Within {
  at?: string;
  until?: string;
}

export const WITHIN_REFUSED =
  "at and until cut a recording only (a conversation, a voice unit or a turn ref)";

/** A page's head: the unit or conversation, and the span it is cut to. */
export const headOf = (
  id: string,
  unit: Unit | undefined,
  span: Within | null
) =>
  `${
    unit
      ? `${unit.source} ${unit.date} "${unit.title}" (${unit.id})`
      : `Conversation ${id}`
  }${span ? `, cut to ${span.at ?? "its start"} until ${span.until ?? "its end"}` : ""}`;

/** What a page on fetches: the id and the span it is cut to, so a page on keeps it. */
export const moreOf = (id: string, span: Within | null) =>
  [
    id,
    ...(span?.at ? [`--at ${span.at}`] : []),
    ...(span?.until ? [`--until ${span.until}`] : []),
  ].join(" ");

/** The later and the earlier of instants as `iso` writes them, the absent ones left out. */
const given = (...t: (string | undefined)[]) =>
  t.filter((x): x is string => Boolean(x)).sort();

/**
 * The span a recording is cut to, inside a unit's own bounds (the later start, the earlier end), its instants as `iso`
 * writes them: the store's are compared as text. A side not given stays open.
 */
export function spanOf(within: Within, unit?: Unit): Within {
  const [at, until] = [within.at, within.until].map(
    (t) => t && iso(Date.parse(t))
  );
  return {
    at: given(unit?.start, at).at(-1),
    until: given(unit?.end, until)[0],
  };
}

/** Whether a span holds no instant: its start at or after its end. */
export const isEmptySpan = ({ at, until }: Within) =>
  Boolean(at && until && at >= until);

/** Whether a turn crosses an edge of the span: begun before it, or ending after it or at an end lifelog never gave. */
const isCrossing = (t: LifelogTurn, { at, until }: Within) =>
  Boolean((at && t.at < at) || (until && (!t.end || t.end > until)));

/**
 * A recording cut to a span keeps, of a turn that crosses an edge, only its words wholly inside, by lifelog's word timings
 * (`readTurnClip`, a turn's first seconds as its cards play them): a turn with no timings is said to be left out, and one
 * whose timings stop before the span's part of it is said to go on unread (life#884). A read that failed throws, so it
 * never reads as silence. A clipped turn's words are lifelog's, cut at places of its own, so a line he deleted or cut in
 * keeps no text at all. Rewrites `said` in place.
 */
export async function clipEdges(
  shown: LifelogTurn[],
  said: Map<string, { speakerId: string | null; text: string }[]>,
  span: Within,
  deletions: Deletions
) {
  await Promise.all(
    shown
      .filter((t) => isCrossing(t, span))
      .map(async (t) => {
        const recording = said.get(t.jobId);
        const words = recording?.[t.turnIndex];
        if (recording && words) {
          const timed = await readTurnClip(t.jobId, t.turnIndex);
          const ref = turnRef(t.jobId, t.turnIndex, t.at);
          recording[t.turnIndex] = {
            ...words,
            // The clip's words are lifelog's as they were, at places of its own: one of a line he deleted or cut keeps none.
            text:
              isGone(ref, deletions) || isCut(ref, deletions)
                ? ""
                : clippedOf(t, timed, span),
          };
        }
      })
  );
}

interface Timed {
  at: string | null;
  text: string;
  until: string | null;
  words: number[][];
}

/** A crossing turn's text: its words inside the span, and what of it was not read. */
export function clippedOf(t: LifelogTurn, timed: Timed | null, span: Within) {
  if (!timed?.at || timed.words.length === 0) {
    return NOT_TIMED;
  }
  const kept = wordsWithin(timed, span);
  const stops = timed.until;
  const goesOn =
    stops !== null &&
    (!t.end || stops < t.end) &&
    (!span.until || stops < span.until);
  return goesOn ? `${kept} ${GOES_ON}`.trim() : kept;
}

export const NOT_TIMED =
  "(a turn crossing the span's edge, left out: lifelog gives no times for its words)";
export const GOES_ON =
  "(…this turn goes on inside the span unread: lifelog times only its first seconds)";

/** A clip's words that lie wholly inside `span`, as its text spells them; "" with no timings. */
export function wordsWithin(
  timed: Pick<Timed, "at" | "text" | "words"> | null,
  span: Within
) {
  if (!timed?.at) {
    return "";
  }
  const start = Date.parse(timed.at);
  const from = span.at ? Date.parse(span.at) : Number.NEGATIVE_INFINITY;
  const until = span.until ? Date.parse(span.until) : Number.POSITIVE_INFINITY;
  let offset = 0;
  let kept = "";
  for (const [begins = 0, ends = 0, length = 0] of timed.words) {
    const word = timed.text.slice(offset, offset + length);
    offset += length;
    if (start + begins >= from && start + ends <= until) {
      kept += word;
    }
  }
  return kept.trim();
}
