import { expect, test } from "bun:test";
import type { Word } from "@life/voice-db/schema";
import { groupOf, type Job, QUOTA, sample, window } from "./sample";

const job = (over: Partial<Job>): Job => ({
  captureStart: "2026-01-01T00:00:00Z",
  en: 40,
  fr: 0,
  id: "a",
  language: "eng",
  latin: 100,
  seconds: 60,
  speakers: 1,
  thai: 0,
  ...over,
});

test("groups by language, with mixed Thai and Latin apart", () => {
  expect(groupOf(job({}))).toBe("en");
  expect(groupOf(job({ en: 0, fr: 40, language: "fra" }))).toBe("fr");
  expect(groupOf(job({ en: 15, fr: 25, language: "fra" }))).toBe("fr+en");
  expect(groupOf(job({ en: 25, fr: 15, language: "eng" }))).toBe("fr+en");
  expect(groupOf(job({ language: "tha", latin: 5, thai: 95 }))).toBe("th");
  expect(groupOf(job({ language: "eng", latin: 60, thai: 40 }))).toBe("mixed");
  // Short, near-silent, a little Thai in English, or another language: left out.
  expect(groupOf(job({ seconds: 30 }))).toBeNull();
  expect(groupOf(job({ latin: 10 }))).toBeNull();
  expect(groupOf(job({ latin: 95, thai: 5 }))).toBeNull();
  expect(groupOf(job({ language: "ita" }))).toBeNull();
});

test("the draw fills each group's quota, half several speakers, the same every time", () => {
  const jobs = Array.from({ length: 200 }, (_, i) =>
    job({
      id: `j${i}`,
      language: i % 2 ? "eng" : "fra",
      speakers: i % 4 < 2 ? 1 : 2,
    })
  );
  const picks = sample(jobs);
  expect(picks.filter((p) => p.group === "en")).toHaveLength(QUOTA.en);
  expect(picks.filter((p) => p.group === "fr" && p.several)).toHaveLength(
    QUOTA.fr / 2
  );
  expect(sample(jobs)).toEqual(picks);
  expect(sample(jobs, "2")).not.toEqual(picks);
});

const word = (start: number, end: number): Word => ({
  end,
  logprob: null,
  spacing: " ",
  speakerId: null,
  start,
  text: "x",
});

test("a long job keeps the 120 s holding the most words, cut between words", () => {
  // Sparse words, then a dense run from 200 s.
  const sparse = Array.from({ length: 20 }, (_, i) =>
    word(i * 10, i * 10 + 0.8)
  );
  const dense = Array.from({ length: 200 }, (_, i) =>
    word(200 + i * 0.5, 200 + i * 0.5 + 0.4)
  );
  const w = window([...sparse, ...dense], 400);
  // From after the word at 180 s: the one at 190 s and the whole dense run.
  expect(w.start).toBeCloseTo(180.8);
  expect(w.words).toHaveLength(201);
  expect(w.words[0]?.start).toBeCloseTo(9.2);
  expect(w.end - w.start).toBeLessThan(120.001);
  const short = sparse.slice(0, 10);
  expect(window(short, 100)).toEqual({ end: 100, start: 0, words: short });
});
