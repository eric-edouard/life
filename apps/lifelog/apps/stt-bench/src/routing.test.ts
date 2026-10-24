import { expect, test } from "bun:test";
import type { Word } from "@lifelog/db/schema";
import {
  compose,
  heardIn,
  type Judged,
  routingErrors,
  segments,
} from "./routing";

const word = (start: number, text: string): Word => ({
  end: start + 0.4,
  logprob: null,
  spacing: " ",
  speakerId: null,
  start,
  text,
});

test("one speaker's close turns join, short ones go, and Thai script labels a segment", () => {
  const turns = [
    { end: 2, speaker: "a", start: 0 },
    { end: 4, speaker: "a", start: 2.2 },
    { end: 4.5, speaker: "b", start: 4.1 },
    { end: 8, speaker: "b", start: 5 },
  ];
  const words = [
    word(0.5, "bonjour"),
    word(3, "ça"),
    word(5.5, "สวัสดี"),
    word(6.5, "ครับ"),
  ];
  expect(segments(turns, words)).toEqual([
    { end: 4, start: 0, thai: false },
    { end: 8, start: 5, thai: true },
  ]);
  expect(segments([{ end: 3, speaker: "a", start: 0 }], [])).toEqual([
    { end: 3, start: 0, thai: null },
  ]);
});

test("a model's text in a segment comes from its tokens' middles", () => {
  const tokens = [
    { end: 0.5, start: 0, text: " Bon" },
    { end: 0.9, start: 0.5, text: "jour" },
    { end: 3, start: 2.5, text: " toi" },
  ];
  expect(heardIn(tokens, { end: 1, start: 0 })).toBe("Bonjour");
});

test("routing errors are seconds of missed Thai and of English or French sent away", () => {
  const s = (start: number, end: number, thai: boolean | null) => ({
    end,
    start,
    thai,
  });
  expect(
    routingErrors([
      { flagged: true, segment: s(0, 10, true) },
      { flagged: false, segment: s(10, 20, true) },
      { flagged: true, segment: s(20, 25, false) },
      { flagged: false, segment: s(25, 45, false) },
      { flagged: true, segment: s(45, 50, null) },
    ])
  ).toEqual({ falseAlarms: 0.2, missed: 0.5 });
});

const turn = (
  start: number,
  end: number,
  lang: string,
  heard = "x"
): Judged => ({
  clip: "c",
  end,
  heard,
  start,
  thai: null,
  voxlingua: { lang, thai: 0 },
});
const ultra = [
  { end: 1, start: 0, text: "one" },
  { end: 3.5, start: 3, text: "two" },
  { end: 6, start: 5, text: "three" },
];

test("a block mostly neither English nor French is the Thai model's whole text", () => {
  const mine = [turn(0, 1, "en"), turn(1, 4, "lo")];
  expect(
    compose({
      heard: null,
      mine,
      timed: false,
      ultra,
      whole: { text: "whole" },
    })
  ).toBe("whole");
});

test("elsewhere, the routed turns take the Thai model's words and the rest stays Ultra's", () => {
  // The turn from 2 to 4 is routed (Ultra wrote nothing there), the others stay.
  const mine = [turn(0, 2, "en"), turn(2, 4, "en", ""), turn(4, 10, "fr")];
  const heard = { segments: [{ end: 3, start: 2, text: "สวัสดี" }] };
  expect(compose({ heard, mine, timed: false, ultra, whole: undefined })).toBe(
    "one สวัสดี three"
  );
  // A whole-clip model's timed words count only inside the routed turns.
  const timed = {
    segments: [{ end: 1, start: 0, text: "nope" }, ...heard.segments],
  };
  expect(
    compose({ heard: timed, mine, timed: true, ultra, whole: undefined })
  ).toBe("one สวัสดี three");
});
