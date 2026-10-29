import { expect, test } from "bun:test";
import type { Word } from "@lifelog/db/schema";
import { parseTranscript, rawOf, textOf } from "./elevenlabs";
import {
  BARS,
  type Judged,
  routeTurns,
  scribeRanges,
  scribeWordsOf,
  thaiChanceOf,
  transcriptOf,
  uncut,
} from "./route-turns";
import type { Heard } from "./speech-service";
import { ownWords } from "./transcript";

// VoxLingua's scores for a turn heard in `language`, roughly as it gives them; null when unjudged.
const SCORES: Record<string, { en: number; fr: number; th: number }> = {
  en: { en: 0.95, fr: 0.02, th: 0.001 },
  fr: { en: 0.02, fr: 0.95, th: 0.001 },
  th: { en: 0.02, fr: 0.01, th: 0.9 },
};
const turn = (
  start: number,
  end: number,
  speaker: string,
  language: string | null
) => ({
  end,
  language,
  scores: language ? (SCORES[language] ?? null) : null,
  speaker,
  start,
});
const word = (start: number, text: string) => ({
  end: start + 0.3,
  start,
  text,
});
const heard = (turns: Heard["turns"], words: Heard["words"]): Heard => ({
  durationSeconds: 60,
  models: {},
  turns,
  words,
});
const { elsewhere: AWAY, thai: HOME } = BARS;

test("a block of Thai goes to Scribe whole, wherever the owner is", () => {
  const thai = heard(
    [turn(0, 8, "0", "th"), turn(8, 20, "1", "th"), turn(20, 23, "0", "en")],
    [word(1, "sawasdee"), word(9, "khrap"), word(21, "ok")]
  );
  expect(routeTurns(thai, HOME)).toEqual({ kind: "whole" });
  expect(routeTurns(thai, AWAY)).toEqual({ kind: "whole" });
});

test("English and French stay local, and so do turns under a second or with no scores", () => {
  const block = heard(
    [
      turn(0, 10, "0", "en"),
      turn(10, 10.6, "1", "th"),
      turn(11, 15, "1", null),
      turn(15, 60, "0", "fr"),
    ],
    [word(1, "hello"), word(12, "hm"), word(16, "salut")]
  );
  expect(routeTurns(block, HOME)).toEqual({ kind: "turns", routed: [] });
  expect(routeTurns(block, AWAY)).toEqual({ kind: "turns", routed: [] });
  expect(routeTurns(heard([], [word(1, "hi")]), HOME)).toEqual({
    kind: "turns",
    routed: [],
  });
});

test("a turn that is only maybe Thai goes to Scribe where Thai is spoken, not elsewhere", () => {
  // Heard as Thai, but alone in an English and French block and with no words from Parakeet.
  const maybe = turn(10, 14, "1", "th");
  const block = heard(
    [turn(0, 10, "0", "en"), maybe, turn(14, 60, "0", "fr")],
    [word(1, "hello"), word(15, "salut")]
  );
  const chance = thaiChanceOf(
    maybe as Judged,
    block.turns as Judged[],
    block.words
  );
  expect(chance).toBeGreaterThan(0.3);
  expect(chance).toBeLessThan(0.7);
  expect(routeTurns(block, HOME)).toEqual({ kind: "turns", routed: [maybe] });
  expect(routeTurns(block, AWAY)).toEqual({ kind: "turns", routed: [] });
});

test("a block goes whole once its routed turns are half its judged seconds", () => {
  // With these scores only the English turn clears the bar: the rest of the block weighs most (a
  // lone Thai turn is the router's known weak spot, issue #241).
  const block = (split: number) =>
    heard(
      [turn(0, split, "0", "th"), turn(split, 20, "1", "en")],
      [word(1, "sawasdee"), word(15, "ok")]
    );
  expect(routeTurns(block(10), AWAY)).toEqual({ kind: "whole" });
  expect(routeTurns(block(10.1), AWAY)).toEqual({
    kind: "turns",
    routed: [turn(10.1, 20, "1", "en")],
  });
});

test("Scribe hears each routed turn with a quarter second around it, overlaps joined", () => {
  expect(
    scribeRanges([
      turn(0.1, 5, "1", "th"),
      turn(5.3, 8, "1", "th"),
      turn(20, 22, "0", null),
    ])
  ).toEqual([
    [0, 8.25],
    [19.75, 22.25],
  ]);
});

const scribeWord = (start: number, text: string, spacing = ""): Word => ({
  end: start + 0.2,
  logprob: -0.1,
  spacing,
  speakerId: "speaker_0",
  start,
  text,
});

test("Scribe's words come back to the block's seconds by the span they fall in", () => {
  const spans = [
    { at: -0.0065, from: 9.75 },
    { at: 10.5, from: 29.75 },
  ];
  expect(
    uncut([scribeWord(1, "a"), scribeWord(11, "b")], spans).map((w) => w.start)
  ).toEqual([1 + 9.75 + 0.0065, 11 + 29.75 - 10.5]);
});

test("the transcript: the service's words outside routed turns, Scribe's inside, each with its turn's speaker", () => {
  const thai = turn(10, 20, "7", "th");
  const block = heard(
    [turn(0, 10, "3", "en"), thai, turn(20, 30, "3", "en")],
    [
      word(1, "Hello"),
      word(2, "there."),
      word(12, "noise"),
      word(21, "Bye."),
      word(35, "late"),
    ]
  );
  const raw = transcriptOf(block, [thai], {
    languageCode: "tha",
    words: [
      scribeWord(11, "สวัส"),
      scribeWord(11.3, "ดี"),
      scribeWord(25, "outside"),
    ],
  });
  const { transcript } = parseTranscript(raw);
  expect(textOf(transcript.words)).toBe("Hello there. สวัสดี Bye. late");
  expect(transcript.words.map((w) => w.speakerId)).toEqual([
    "speaker_0",
    "speaker_0",
    "speaker_1",
    "speaker_1",
    "speaker_0",
    "speaker_0",
  ]);
  expect(transcript.turns.map((t) => t.text)).toEqual([
    "Hello there.",
    "สวัสดี",
    "Bye.",
    "late",
  ]);
  expect(transcript.languageCode).toBe("eng");
  expect(transcriptOf(block, [thai], null).language_code).toBe("eng");
  expect(
    transcriptOf(heard([turn(0, 5, "0", null)], []), [], null).language_code
  ).toBe("und");
});

test("Scribe's words of a whole block go to the stored turns they fall in, labels and count kept", () => {
  const w = (start: number, text: string, speakerId: string | null) => ({
    end: start + 0.4,
    logprob: null,
    spacing: " ",
    speakerId,
    start,
    text,
  });
  const stored = {
    languageCode: "eng",
    languageProbability: 1,
    turns: [
      { end: 2.4, speakerId: "speaker_1", start: 1, text: "hi there" },
      { end: 6.4, speakerId: "speaker_0", start: 6, text: "noise" },
      { end: 9.4, speakerId: "speaker_1", start: 9, text: "ok" },
    ],
    words: [
      w(1, "hi", "speaker_1"),
      w(2, "there", "speaker_1"),
      w(6, "noise", "speaker_0"),
      w(9, "ok", "speaker_1"),
    ],
  };
  // The word at 3.5 falls between turns: it goes to the nearest. The middle turn gets none.
  const next = scribeWordsOf(stored, {
    languageCode: "tha",
    words: [w(1, "hello", null), w(3.5, "friend", null), w(9, "okay", null)],
  });
  expect(next.turns).toEqual([
    { end: 3.9, speakerId: "speaker_1", start: 1, text: "hello friend" },
    { end: 6.4, speakerId: "speaker_0", start: 6, text: "noise" },
    { end: 9.4, speakerId: "speaker_1", start: 9, text: "okay" },
  ]);
  expect(next.words.map((x) => x.speakerId)).toEqual([
    "speaker_1",
    "speaker_1",
    "speaker_0",
    "speaker_1",
  ]);
  // Stored back in Scribe's shape, a parser bump reads the same words.
  expect(
    parseTranscript(rawOf(next)).transcript.words.map((x) => x.text)
  ).toEqual(next.words.map((x) => x.text));
});

test("a stretched Scribe word is cut at the next turn, so no turn takes another's words", () => {
  const w = (
    start: number,
    end: number,
    text: string,
    speakerId: string | null
  ) => ({
    end,
    logprob: null,
    spacing: " ",
    speakerId,
    start,
    text,
  });
  const stored = {
    languageCode: "eng",
    languageProbability: 1,
    turns: [
      { end: 10, speakerId: "speaker_0", start: 0, text: "a" },
      { end: 14, speakerId: "speaker_1", start: 10, text: "b" },
      { end: 20, speakerId: "speaker_0", start: 14.5, text: "c" },
    ],
    words: [
      w(0, 10, "a", "speaker_0"),
      w(10, 14, "b", "speaker_1"),
      w(14.5, 20, "c", "speaker_0"),
    ],
  };
  const next = scribeWordsOf(stored, {
    languageCode: "tha",
    words: [w(1, 2, "x", null), w(9.8, 40, "stretched", null)],
  });
  expect(
    next.turns.map((t) => ownWords(t, next.words).map((x) => x.text))
  ).toEqual([["x", "stretched"], ["b"], ["c"]]);
});
