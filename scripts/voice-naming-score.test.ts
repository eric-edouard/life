import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_DATA_DIR } from "@life/server/src/core/paths";
import {
  type Guessed,
  isInsideData,
  reportOf,
  scoreOf,
} from "./voice-naming-score";

// Made-up voices: each line is one guess on one voice with what lifelog says of it now.
const g = (voice: string, o: Partial<Guessed> = {}): Guessed => ({
  answer: "person:ann",
  at: "2026-10-10T00:00:00.000Z",
  confidence: "sure",
  likeness: true,
  person: "person:ann",
  recognized: null,
  voice,
  words: 10,
  ...o,
});

test("the score counts right and wrong per 100 by voice and by guess, with me, no likeness, not relevant, mixed and doubted names apart", () => {
  const s = scoreOf([
    g("a"),
    g("b", { person: "person:bob" }),
    // c: guessed twice, a wrong one then a newer right one: one voice (the newest), two guesses.
    g("c", { at: "2026-10-09T00:00:00.000Z", person: "person:bob" }),
    g("c"),
    g("d", { confidence: "likely", likeness: false, person: "person:bob" }),
    g("e", { confidence: "likely" }),
    g("f", { person: "me" }),
    g("g", { confidence: "weak", person: "person:bob" }),
    g("h", { answer: "not_relevant", person: "person:ann" }),
    g("i", { apart: "mixed" }),
    g("j", { apart: "turn" }),
    g("k", { answer: null, person: "person:ann", recognized: "person:ann" }),
    g("l", { answer: null, person: "person:bob", recognized: "person:ann" }),
  ]);
  // Sure, by voice: a right, b wrong, c right (newest), the others do not count here.
  expect(s.byVoice.sure).toEqual({ n: 3, per100: 33.3, wrong: 1 });
  expect(s.byVoice.likely).toEqual({ n: 2, per100: 50, wrong: 1 });
  // By guess: c counts twice.
  expect(s.byGuess.sure).toEqual({ n: 4, per100: 50, wrong: 2 });
  expect(s.noLikeness.likely).toEqual({ n: 1, per100: 100, wrong: 1 });
  expect(s.meGuesses).toBe(1);
  expect(s.notRelevant).toEqual({ guessed: 1, voices: 1 });
  expect(s.leftOut).toEqual({ mixed: 1, turnByTurn: 1 });
  expect(s.doubted).toEqual({ asked: 2, sameAsLifelog: 1 });
  // Words of the answered voices: right a, c, e (30) of a, b, c, d, e, f, g (70).
  expect(s.words).toEqual({ all: 70, right: 30 });
  expect(s.voices).toBe(7);
  expect(reportOf(s).join("\n")).toContain(
    "by voice sure: 1 wrong of 3 (33.3 per 100)"
  );
});

test("a trial folder inside his data is refused", () => {
  expect(isInsideData(join(OWNER_DATA_DIR, "memory", "trial"))).toBe(true);
  expect(isInsideData(join(OWNER_DATA_DIR, "docs", "trial"))).toBe(true);
  expect(isInsideData(OWNER_DATA_DIR)).toBe(true);
  expect(isInsideData(join(tmpdir(), "voice-trial"))).toBe(false);
});
