// Language routing: which stretches of a recording hold Thai, so that only those go to a model that
// knows Thai while the rest stay with a faster English and French one. A segment is a speaker turn
// (a diarizer's); Scribe's words say whether it holds Thai (written in Thai script).
import type { Word } from "@lifelog/db/schema";
import { routeTurns, toScribe } from "@lifelog/server/src/route-turns";
import { THAI, type Turn } from "./score";

// Turns of one speaker this close make one segment; shorter ones say too little to judge.
const JOIN_GAP = 0.5;
const MIN_SECONDS = 1;
// A segment holds Thai when at least this share of its words is in Thai script.
export const THAI_SHARE = 0.3;

export interface Segment {
  end: number;
  start: number;
  // Whether Scribe heard Thai in it; null when Scribe heard no words there.
  thai: boolean | null;
}

export function segments(turns: Turn[], words: Word[]): Segment[] {
  const joined: Turn[] = [];
  for (const t of [...turns].sort((a, b) => a.start - b.start)) {
    const last = joined.at(-1);
    if (last && last.speaker === t.speaker && t.start - last.end < JOIN_GAP) {
      last.end = t.end;
    } else {
      joined.push({ ...t });
    }
  }
  return joined
    .filter((t) => t.end - t.start >= MIN_SECONDS)
    .map(({ end, start }) => {
      const inside = words.filter((w) => {
        const middle = (w.start + w.end) / 2;
        return middle >= start && middle < end;
      });
      const thai = inside.filter((w) => THAI.test(w.text)).length;
      return {
        end,
        start,
        thai: inside.length > 0 ? thai / inside.length >= THAI_SHARE : null,
      };
    });
}

// The text a model heard in a segment, from its timed tokens (Parakeet's).
export const heardIn = (
  tokens: { end: number; start: number; text: string }[],
  s: { end: number; start: number }
) =>
  tokens
    .filter(
      (t) => (t.start + t.end) / 2 >= s.start && (t.start + t.end) / 2 < s.end
    )
    .map((t) => t.text)
    .join("")
    .trim();

// A detector's cost in seconds of speech: Thai it left with the English and French model (missed),
// and English or French it sent to the Thai one for nothing (false alarms), each over its whole.
export function routingErrors(
  judged: { flagged: boolean; segment: Segment }[]
) {
  const seconds = (xs: typeof judged) =>
    xs.reduce((t, { segment: s }) => t + s.end - s.start, 0);
  const thai = judged.filter((j) => j.segment.thai === true);
  const other = judged.filter((j) => j.segment.thai === false);
  return {
    falseAlarms:
      seconds(other.filter((j) => j.flagged)) / Math.max(1, seconds(other)),
    missed:
      seconds(thai.filter((j) => !j.flagged)) / Math.max(1, seconds(thai)),
  };
}

export interface Judged extends Segment {
  clip: string;
  heard: string;
  voxlingua?: { lang: string; thai: number };
}

// A turn leaves the English and French model by the server's rule (apps/server/src/route-turns.ts:
// VoxLingua hears Thai in it, the owner's rule of 24 Oct 2026). It once also took any other language
// and turns Parakeet Ultra wrote nothing for, but VoxLingua tags short noisy French as other
// languages; the numbers in docs/research/transcription-bench.md are that earlier rule's.
export const routed = (s: Judged) => toScribe(s.voxlingua?.lang ?? null);
// Parakeet Ultra wrote nothing where someone spoke: counted in the bench's report, no longer routed.
export const silent = (s: Judged) => s.heard === "";

// What a model wrote for a clip: its text and its segments with their times.
interface Heard {
  segments?: Record<string, unknown>[] | null;
  text?: string;
}

const SPACES = /\s+/g;

// One clip's pipeline text: the Thai model's whole transcript when the server would send the whole
// block to Scribe (`routeTurns`); else Ultra's tokens outside the routed turns and the Thai model's
// inside them (its turn-by-turn segments, or its timed words when `timed`), in time order.
export function compose({
  heard,
  mine,
  timed,
  ultra,
  whole,
}: {
  heard: Heard | null | undefined;
  mine: Judged[];
  timed: boolean;
  ultra: { end: number; start: number; text: string }[];
  whole: Heard | undefined;
}) {
  const route = routeTurns({
    turns: mine.map((s) => ({
      end: s.end,
      language: s.voxlingua?.lang ?? null,
      speaker: "",
      start: s.start,
    })),
  });
  if (route.kind === "whole" && whole?.text !== undefined) {
    return whole.text;
  }
  const turns = mine.filter(routed);
  const inside = (t: number) => turns.some((s) => s.start <= t && t < s.end);
  const kept = ultra
    .filter((t) => !inside((t.start + t.end) / 2))
    .map((t) => ({ at: t.start, text: t.text }));
  const swapped = (heard?.segments ?? [])
    .filter((s) => !timed || inside((Number(s.start) + Number(s.end)) / 2))
    .map((s) => ({ at: Number(s.start), text: ` ${String(s.text)} ` }));
  return [...kept, ...swapped]
    .sort((a, b) => a.at - b.at)
    .map((p) => p.text)
    .join("")
    .replace(SPACES, " ")
    .trim();
}
