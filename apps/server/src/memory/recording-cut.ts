import { iso } from "../core/clock";
import type { Unit } from "../records/unit";
import type { LifelogTurn } from "../sources/lifelog";
import { readTurnClip } from "../sources/lifelog-voices";

// A recording read cut to a span of instants, such as a call's exact one (`fetch`'s `at` and `until`, life#875): the
// turns that overlap it (`turnsOverlapping`), a turn crossing an edge kept to its words wholly inside.

/** A span of instants (ISO, `until` exclusive) a recording is cut to: a call's `at` and `until`. */
export interface Within {
  at?: string;
  until?: string;
}

export const WITHIN_REFUSED =
  "at and until cut a recording only (a conversation, a voice unit or a turn ref)";

const END = "9999";

/** A page's head: the unit or conversation, and the span it is cut to. */
export const headOf = (
  id: string,
  unit: Unit | undefined,
  span: { at: string; until: string } | null
) =>
  `${
    unit
      ? `${unit.source} ${unit.date} "${unit.title}" (${unit.id})`
      : `Conversation ${id}`
  }${span ? `, cut to ${span.at || "its start"} until ${span.until === END ? "its end" : span.until}` : ""}`;

/** What a page on fetches: the id and, cut to a span, the bounds given, so the span holds. */
export const moreOf = (
  id: string,
  within: Within,
  span: { at: string; until: string } | null
) =>
  [
    id,
    ...(span && within.at ? [`--at ${span.at}`] : []),
    ...(span && within.until ? [`--until ${span.until}`] : []),
  ].join(" ");

/**
 * The span a recording is cut to, inside a unit's own bounds (the later start, the earlier end), as `iso` writes
 * instants: the store's are compared as text.
 */
export function spanOf(within: Within, unit?: Unit) {
  const [at, until] = [within.at, within.until].map(
    (t) => t && iso(Date.parse(t))
  );
  return {
    at: [unit?.start ?? "", at ?? ""].sort().at(-1) ?? "",
    until: [unit?.end ?? END, until ?? END].sort()[0] ?? END,
  };
}

/**
 * A recording cut to a span keeps, of a turn that crosses an edge, only its words wholly inside, by lifelog's word timings
 * (`readTurnClip`); with no timings (no clip, a read that failed) the turn says nothing. Rewrites `said` in place.
 */
export async function clipEdges(
  shown: LifelogTurn[],
  said: Map<string, { speakerId: string | null; text: string }[]>,
  span: { at: string; until: string }
) {
  const crossing = shown.filter(
    (t) => t.at < span.at || (t.end ?? t.at) > span.until
  );
  await Promise.all(
    crossing.map(async (t) => {
      const recording = said.get(t.jobId);
      const words = recording?.[t.turnIndex];
      if (recording && words) {
        const timed = await readTurnClip(t.jobId, t.turnIndex).catch(
          () => null
        );
        recording[t.turnIndex] = { ...words, text: wordsWithin(timed, span) };
      }
    })
  );
}

/** A clip's words that lie wholly inside `span`, as its text spells them; "" with no timings. */
export function wordsWithin(
  timed: { at: string | null; text: string; words: number[][] } | null,
  span: { at: string; until: string }
) {
  if (!timed?.at) {
    return "";
  }
  const [start, from, until] = [timed.at, span.at, span.until].map((t) =>
    Date.parse(t)
  ) as [number, number, number];
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
