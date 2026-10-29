import { expect, test } from "bun:test";
import type { Word } from "@lifelog/db/schema";
import { parseTranscript, textOf } from "./elevenlabs";
import { routeTurns, scribeRanges, transcriptOf, uncut } from "./route-turns";
import type { Heard } from "./speech-service";

const turn = (
  start: number,
  end: number,
  speaker: string,
  language: string | null
) => ({
  end,
  language,
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

test("only a turn of a second or more VoxLingua hears as Thai is routed: other languages and wordless turns stay local", () => {
  const thai = turn(10, 20, "1", "th");
  const silent = turn(20, 24, "0", "en");
  const block = heard(
    [
      turn(0, 10, "0", "en"),
      thai,
      silent,
      turn(24, 24.6, "1", null),
      turn(25, 25.8, "1", "th"),
      turn(30, 130, "0", "fr"),
      // Noisy French a café blurs, heard as Breton and Portuguese (24 Oct): it stays local.
      turn(130, 132, "0", "br"),
      turn(132, 135, "0", "pt"),
    ],
    // "ok" starts in the silent turn but its middle is past it.
    [
      word(1, "hello"),
      word(12, "sawasdee"),
      word(23.9, "ok"),
      word(31, "salut"),
    ]
  );
  expect(routeTurns(block)).toEqual({ kind: "turns", routed: [thai] });
});

test("a block 10% Thai goes to Scribe whole; silent turns don't count toward it", () => {
  const thai = heard(
    [turn(0, 3, "0", "en"), turn(3, 10, "1", "th")],
    [word(1, "hi")]
  );
  expect(routeTurns(thai)).toEqual({ kind: "whole" });
  // One Thai turn, and the rest of the Thai heard as Lao, Javanese or English, with Parakeet's
  // made-up words in it: it goes whole.
  const mixed = heard(
    [
      turn(0, 2, "1", "th"),
      turn(2, 6, "1", "lo"),
      turn(6, 10, "1", "jw"),
      turn(10, 18, "1", "en"),
    ],
    [word(3, "baman"), word(11, "elik"), word(12, "chandai")]
  );
  expect(routeTurns(mixed)).toEqual({ kind: "whole" });
  const thaiSecondIn = (seconds: number) =>
    routeTurns(heard([turn(0, 1, "1", "th"), turn(1, seconds, "0", "en")], []));
  expect(thaiSecondIn(10.5).kind).toBe("turns");
  expect(thaiSecondIn(10).kind).toBe("whole");
  const quiet = heard(
    [turn(0, 3, "0", "en"), turn(3, 10, "1", "en")],
    [word(1, "hi")]
  );
  expect(routeTurns(quiet)).toMatchObject({ kind: "turns" });
  expect(routeTurns(heard([], [word(1, "hi")]))).toEqual({
    kind: "turns",
    routed: [],
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
