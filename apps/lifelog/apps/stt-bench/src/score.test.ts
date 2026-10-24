import { expect, test } from "bun:test";
import {
  distance,
  errors,
  languageOf,
  speakerErrors,
  tally,
  tokens,
  wordErrors,
} from "./score";

test("Latin words ignore case, punctuation and elisions", () => {
  expect(tokens("Bonjour, l'Homme… It's 2 o'clock!")).toEqual([
    "bonjour",
    "l",
    "homme",
    "it",
    "s",
    "2",
    "o",
    "clock",
  ]);
});

test("hesitations go and contractions are spelled out", () => {
  expect(tokens("constructor toString")).toEqual(["constructor", "tostring"]);
  expect(tokens("Euh, I wanna go, um, OK")).toEqual([
    "i",
    "want",
    "to",
    "go",
    "okay",
  ]);
});

test("stutters count once", () => {
  expect(tokens("the the button, en-entering into")).toEqual([
    "the",
    "button",
    "entering",
    "into",
  ]);
});

test("drift counts really different words only", () => {
  // A small word dropped, a near-spelling: no drift.
  expect(
    wordErrors("je vais au marché demain", "je vais marchés demain")
  ).toEqual({
    errors: 0,
    length: 3,
  });
  // English drifting into French: "demain" became "girl" and "found" came in; the small words
  // that came with them do not count.
  expect(
    wordErrors(
      "on se voit demain matin",
      "on se voit and you found my girl matin"
    )
  ).toEqual({ errors: 2, length: 3 });
});

test("Thai counts characters, spaces or not, and keeps Latin glued to it", () => {
  expect(tokens("สวัสดี ครับ")).toEqual(tokens("สวัสดีครับ"));
  expect(tokens("okครับ")).toEqual(["ok", "ค", "ร", "ั", "บ"]);
});

test("distance counts substitutions, insertions and deletions", () => {
  expect(distance(["a", "b", "c"], ["a", "x", "c", "d"])).toBe(2);
  expect(distance([], ["a"])).toBe(1);
});

test("errors are weighted by the reference's length", () => {
  expect(errors("le chat dort", "le chien dort")).toEqual({
    errors: 1,
    length: 3,
  });
});

test("languages compare whatever a model calls them", () => {
  expect(languageOf("French")).toBe("fra");
  expect(languageOf("en")).toBe("eng");
  expect(languageOf(null)).toBeNull();
  expect(languageOf(["French", "English", "French"])).toBe("fra");
});

const w = (start: number, speakerId: string | null) => ({
  end: start + 0.5,
  speakerId,
  start,
});

test("speakers pair one to one whatever their labels, missed words count", () => {
  const words = [w(0, "a"), w(1, "a"), w(2, "b"), w(3, "b"), w(9, "b")];
  const turns = [
    { end: 1.9, speaker: "SPEAKER_01", start: 0 },
    { end: 3.9, speaker: "SPEAKER_00", start: 1.9 },
  ];
  expect(speakerErrors(words, turns)).toEqual({ errors: 1, length: 5 });
  // One speaker heard for two: the second's words are all wrong.
  expect(
    speakerErrors(words.slice(0, 4), [{ end: 4, speaker: "x", start: 0 }])
  ).toEqual({ errors: 2, length: 4 });
});

test("a model's tally: text and drift by group, language, speakers and speed", () => {
  const said = (start: number, text: string, speakerId: string) => ({
    end: start + 1,
    logprob: null,
    spacing: " ",
    speakerId,
    start,
    text,
  });
  const clip = {
    end: 10,
    group: "en" as const,
    id: "c",
    several: true,
    start: 0,
    words: [
      said(0, "hello", "a"),
      said(2, "there", "a"),
      said(5, "friend", "b"),
    ],
  };
  const out = {
    language: "en",
    segments: [
      { end: 4, speaker: "x", start: 0 },
      { end: 10, speaker: "y", start: 4 },
    ],
    text: "hello there frend",
    wallSeconds: 5,
  };
  const t = tally([{ clip, out }]);
  expect(t.rate("text en")).toBe("33.3%");
  expect(t.rate("drift en")).toBe("0.0%");
  expect(t.rate("language")).toBe("0.0%");
  expect(t.rate("speakers")).toBe("0.0%");
  expect(t.has("text fr")).toBe(false);
  expect(t.speed).toBe("2×");
});
