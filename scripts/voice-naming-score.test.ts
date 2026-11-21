import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Guessed,
  prepareTrial,
  reportOf,
  scoreOf,
} from "./voice-naming-score";

// Made-up voices: each line is one guess on one voice with what lifelog says of it now.
const g = (voice: string, o: Partial<Guessed> = {}): Guessed => ({
  answer: "person:ann",
  at: "2026-10-10T00:00:00.000Z",
  confidence: "sure",
  keys: [`${voice}#0`],
  likeness: true,
  part: 1,
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

test('the score counts the voices he answered "A stranger" that were guessed a person or him, apart from the wrong counts', () => {
  const stranger = (voice: string, o: Partial<Guessed> = {}) =>
    g(voice, { answer: "unknown", ...o });
  const s = scoreOf([
    stranger("a"),
    stranger("b", { confidence: "likely" }),
    stranger("c", { person: "me" }),
    stranger("d", { confidence: "weak" }),
    stranger("e", { person: "unknown" }),
    g("f"),
  ]);
  expect(s.strangers).toEqual({ likely: 1, sure: 2, voices: 5 });
  // They are not answered persons: nothing of them is wrong or counted there.
  expect(s.voices).toBe(1);
  expect(s.byVoice.sure).toEqual({ n: 1, per100: 0, wrong: 0 });
  expect(reportOf(s).join("\n")).toContain(
    'voices answered "A stranger": 5, guessed as a person or me at sure: 2, at likely: 1'
  );
});

test("the trial folder: a plain new one is accepted; one inside his data, by a link, after a link with .., or through a dangling link, is refused", () => {
  const base = mkdtempSync(join(tmpdir(), "score-link-"));
  const data = join(base, "data");
  mkdirSync(join(data, "docs"), { recursive: true });
  mkdirSync(join(base, "out"));
  symlinkSync(data, join(base, "Life"));
  symlinkSync(join(data, "docs"), join(base, "out", "lnk"));
  symlinkSync(join(data, "nothere"), join(base, "out", "dangling"));
  const refused = (p: string) => () => prepareTrial(p, data);
  // Plain: a folder of its own, made.
  expect(prepareTrial(join(base, "elsewhere", "trial"), data)).toBe(
    realpathSync(join(base, "elsewhere", "trial"))
  );
  expect(refused(join(data, "memory", "trial"))).toThrow();
  expect(refused(join(base, "Life", "docs"))).toThrow();
  expect(refused(join(base, "Life", "docs", "new", "deeper"))).toThrow();
  // `..` after a link would leave the link's folder for data/: refused before anything is resolved or made.
  expect(refused(`${join(base, "out", "lnk")}/../trial`)).toThrow("`..`");
  expect(existsSync(join(data, "trial"))).toBe(false);
  // A dangling link into his data: whatever mkdir does with it, nothing is left in his data.
  expect(refused(join(base, "out", "dangling", "trial"))).toThrow();
  expect(existsSync(join(data, "nothere"))).toBe(false);
});

test("by group: one card per part and answer, its name the one person its sure or likely guesses agree on", () => {
  const s = scoreOf([
    // Part 1, Ann's voices: both guessed Ann (one weak Bob guess counts for nothing): shown, right.
    g("a"),
    g("b", { confidence: "likely" }),
    g("c", { confidence: "weak", person: "person:bob" }),
    // Part 2, Ann's voices: Ann and Bob disagree: nothing shown.
    g("d", { part: 2 }),
    g("e", { part: 2, person: "person:bob" }),
    // Part 3, a voice he said is no one he cares about, guessed Bob: shown, wrong.
    g("f", { answer: "not_relevant", part: 3, person: "person:bob" }),
    // An older guess of a voice in another part counts for nothing: its newest is in part 1.
    g("b", { at: "2026-10-09T00:00:00.000Z", part: 5, person: "person:bob" }),
    // Part 4, only "unknown" and me: nothing shown.
    g("g", { part: 4, person: "unknown" }),
    g("h", { part: 4, person: "me" }),
  ]);
  // Both shown cards hold a sure guess of their person, so both start "Yes" ticked: one right of two, under the bar.
  expect(s.byGroup).toEqual({
    groups: 4,
    likely: { n: 0, right: 0 },
    right: 1,
    shown: 2,
    sure: { n: 2, right: 1 },
  });
  const report = reportOf(s).join("\n");
  expect(report).toContain(
    "by group: 4 answered groups, a name shown on 2, his answer on 1"
  );
  expect(report).toContain(
    "by group sure: 1 right of 2 (50 in 100), bar 97: under"
  );
  expect(report).toContain(
    "by group likely: 0 right of 0 (- in 100), bar 85: -"
  );
});

test("by group reads each turn's newest guess, as the card does: a voice whose turns are guessed two people shows no name", () => {
  const s = scoreOf([
    // Voice x, two turns: the newest guess (Ann) covers only the first; the second's newest is an older Bob guess.
    g("x", { keys: ["x#0"] }),
    g("x", {
      at: "2026-10-09T00:00:00.000Z",
      keys: ["x#0", "x#1"],
      person: "person:bob",
    }),
  ]);
  expect(s.byGroup).toEqual({
    groups: 1,
    likely: { n: 0, right: 0 },
    right: 0,
    shown: 0,
    sure: { n: 0, right: 0 },
  });
});
