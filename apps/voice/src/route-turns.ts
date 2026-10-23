// What a block's words come from when the speech service transcribes it (docs/voice/processing.md,
// "Who transcribes"): its own words for English and French, Scribe's for the turns it routes. A
// turn of a second or more is routed when VoxLingua107 hears neither English nor French in it
// (foreign), or Parakeet Ultra wrote nothing there; a block 70% foreign goes to Scribe whole. The
// bench's rule exactly (apps/transcription-bench/src/routing.ts), and its numbers:
// docs/voice/research/transcription-bench.md.
//
// The result is a transcript in Scribe's own shape, so it is stored, parsed and turned into turns
// exactly like one of Scribe's (jobs.ts `complete`).

import type { Word } from "@life/voice-db/schema";
import type { CutSpan } from "./audio";
import type { Heard } from "./speech-service";

type HeardTurn = Heard["turns"][number];

const OURS = new Map([
  ["en", "eng"],
  ["fr", "fra"],
]);
const WHOLE_BLOCK = 0.7;
const MIN_ROUTED_SECONDS = 1;
// A routed turn's audio reaches Scribe with this much around it, so a word Nemotron's boundary
// clips is still heard whole; only the words inside the turn are kept.
const PAD_SECONDS = 0.25;

const seconds = (turns: HeardTurn[]) =>
  turns.reduce((sum, t) => sum + t.end - t.start, 0);
const inside = (turn: HeardTurn, at: number) =>
  turn.start <= at && at < turn.end;

export type Route = { kind: "whole" } | { kind: "turns"; routed: HeardTurn[] };

export function routeTurns({ turns, words }: Heard): Route {
  const judged = turns.filter((t) => t.end - t.start >= MIN_ROUTED_SECONDS);
  const foreign = judged.filter(
    (t) => t.language !== null && !OURS.has(t.language)
  );
  if (judged.length > 0 && seconds(foreign) >= WHOLE_BLOCK * seconds(judged)) {
    return { kind: "whole" };
  }
  const silent = (t: HeardTurn) =>
    !words.some((w) => inside(t, (w.start + w.end) / 2));
  return {
    kind: "turns",
    routed: judged.filter((t) => foreign.includes(t) || silent(t)),
  };
}

// The stretches of audio Scribe hears for the routed turns: each padded, overlaps joined.
export function scribeRanges(routed: HeardTurn[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const t of routed) {
    const start = Math.max(0, t.start - PAD_SECONDS);
    const last = ranges.at(-1);
    if (last && start <= last[1]) {
      last[1] = t.end + PAD_SECONDS;
    } else {
      ranges.push([start, t.end + PAD_SECONDS]);
    }
  }
  return ranges;
}

// Scribe's words from the cut (cutOggOpus's spans), back in the block's seconds.
export function uncut(words: Word[], spans: CutSpan[]): Word[] {
  return words.flatMap((w) => {
    const span = spans.findLast((s) => s.at <= w.start) ?? spans[0];
    if (!span) {
      return [];
    }
    const shift = span.from - span.at;
    return [{ ...w, end: w.end + shift, start: w.start + shift }];
  });
}

// The block's transcript in Scribe's shape: the service's words outside the routed turns, Scribe's
// (already in block seconds) inside them, each with the speaker of the turn it starts in, or of the
// nearest one. Its language is Scribe's when Scribe heard most of it, else English or French,
// whichever was spoken longer.
export function transcriptOf(
  { turns, words }: Heard,
  routed: HeardTurn[],
  scribe: { languageCode: string; words: Word[] } | null
) {
  const isRouted = (at: number) => routed.some((t) => inside(t, at));
  const distance = (t: HeardTurn, at: number) =>
    inside(t, at) ? 0 : Math.min(Math.abs(t.start - at), Math.abs(t.end - at));
  const turnAt = (at: number) =>
    turns.reduce<HeardTurn | undefined>(
      (best, t) => (!best || distance(t, at) < distance(best, at) ? t : best),
      undefined
    );
  const speakers = [...new Set(turns.map((t) => t.speaker))];
  const placed = [
    ...words
      .filter((w) => !isRouted(w.start))
      .map((w) => ({ ...w, fromScribe: false, logprob: null, spacing: " " })),
    ...(scribe?.words ?? [])
      .filter((w) => isRouted(w.start))
      .map((w) => ({ ...w, fromScribe: true })),
  ].sort((a, b) => a.start - b.start);
  const spoken = (language: string) =>
    seconds(
      turns.filter((t) => t.language === language && !routed.includes(t))
    );
  const [mostly = "und"] = [...OURS.keys()]
    .filter((language) => spoken(language) > 0)
    .sort((a, b) => spoken(b) - spoken(a));
  const languageCode =
    scribe && seconds(routed) > seconds(turns) - seconds(routed)
      ? scribe.languageCode
      : (OURS.get(mostly) ?? "und");
  return {
    language_code: languageCode,
    language_probability: 1,
    words: placed.flatMap((w, i) => {
      const before = placed[i - 1];
      const turn = turnAt(w.start);
      // Scribe's spacing holds within one of its turns (Thai has none); anywhere else, a space.
      const spacing =
        before?.fromScribe && w.fromScribe && turnAt(before.start) === turn
          ? w.spacing
          : " ";
      return [
        ...(before && spacing ? [{ text: spacing, type: "spacing" }] : []),
        {
          end: w.end,
          logprob: w.logprob,
          speaker_id: turn ? `speaker_${speakers.indexOf(turn.speaker)}` : null,
          start: w.start,
          text: w.text,
          type: "word",
        },
      ];
    }),
  };
}
