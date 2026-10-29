// What a block's words come from when the speech service transcribes it (docs/processing.md,
// "Who transcribes"): its own words, and Scribe's only for Thai (the owner's rule, 24 Oct 2026). A
// turn of a second or more is routed when its chance of being Thai, read from VoxLingua107's scores
// and the rest of the block, clears the bar of the place the owner was in; a block mostly routed
// goes to Scribe whole (why: docs/decisions.md).
//
// The result is a transcript in Scribe's own shape, so it is stored, parsed and turned into turns
// exactly like one of Scribe's (jobs.ts `complete`). The transcription bench routes by the same
// rule (apps/stt-bench/src/routing.ts imports it).

import type { Word } from "@lifelog/db/schema";
import type { CutSpan } from "./audio";
import type { Heard } from "./speech-service";

type HeardTurn = Heard["turns"][number];

const OURS = new Map([
  ["en", "eng"],
  ["fr", "fra"],
]);
// A turn's chance of being Thai is a logistic over these features (`featuresOf`), fitted by the
// transcription bench on 29 Oct 2026: 4,897 turns over 20 days, scored on days it didn't train on.
const WEIGHTS = [0.3866, -0.0804, 0.1439, 1.1549, -0.3182, 5.3071, 4.4407];
const BIAS = -0.6942;
// Where Thai is spoken a weaker chance is routed. The place is the bar, never a feature: learned, it
// made Thai spoken elsewhere count as not Thai.
const THAI_ZONES = new Set(["Asia/Bangkok"]);
const barOf = (zone: string) => (THAI_ZONES.has(zone) ? 0.3 : 0.7);
const WHOLE_BLOCK = 0.5;
const MIN_ROUTED_SECONDS = 1;
// A routed turn's audio reaches Scribe with this much around it, so a word Nemotron's boundary
// clips is still heard whole; only the words inside the turn are kept.
const PAD_SECONDS = 0.25;

const seconds = (turns: HeardTurn[]) =>
  turns.reduce((sum, t) => sum + t.end - t.start, 0);
const inside = (turn: HeardTurn, at: number) =>
  turn.start <= at && at < turn.end;

export type Route = { kind: "whole" } | { kind: "turns"; routed: HeardTurn[] };

export type Judged = HeardTurn & { scores: NonNullable<HeardTurn["scores"]> };
const log = (p: number) => Math.log(Math.max(p, 1e-6));

// VoxLingua's view of the turn, whether Parakeet wrote anything in it, its length, and how Thai the
// rest of the block sounds (each turn weighted by its seconds).
export function featuresOf(
  turn: Judged,
  judged: Judged[],
  words: Heard["words"]
) {
  const { en, fr, th } = turn.scores;
  const rest = judged.filter((t) => t !== turn);
  const weight = seconds(rest) || 1;
  const mean = (f: (t: Judged) => number) =>
    rest.reduce((sum, t) => sum + f(t) * (t.end - t.start), 0) / weight;
  const wordless = !words.some(
    (w) => inside(turn, w.start) && w.text.trim() !== ""
  );
  return [
    log(th),
    log(en + fr),
    log(1 - th - en - fr),
    wordless ? 1 : 0,
    Math.log(turn.end - turn.start),
    mean((t) => t.scores.th),
    mean((t) => 1 - t.scores.en - t.scores.fr),
  ];
}

/** A turn's chance of being Thai. */
export function thaiChanceOf(
  turn: Judged,
  judged: Judged[],
  words: Heard["words"]
) {
  const z = featuresOf(turn, judged, words).reduce(
    (sum, x, i) => sum + x * (WEIGHTS[i] ?? 0),
    BIAS
  );
  return 1 / (1 + Math.exp(-z));
}

/** A block's turns the router judges: a second or more, with VoxLingua's scores. */
export const judgedOf = (turns: HeardTurn[]) =>
  turns.filter(
    (t): t is Judged =>
      t.end - t.start >= MIN_ROUTED_SECONDS && t.scores !== null
  );

export function routeTurns(
  { turns, words }: Pick<Heard, "turns" | "words">,
  zone: string
): Route {
  const judged = judgedOf(turns);
  const thai = judged.filter(
    (t) => thaiChanceOf(t, judged, words) >= barOf(zone)
  );
  if (judged.length > 0 && seconds(thai) >= WHOLE_BLOCK * seconds(judged)) {
    return { kind: "whole" };
  }
  return { kind: "turns", routed: thai };
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
