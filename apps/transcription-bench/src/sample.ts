import { createHash } from "node:crypto";
import type { Word } from "@life/voice-db/schema";

// Which jobs the bench reads: a fixed, stratified draw by language and by one or several speakers,
// the same on every run for the same jobs and seed.

export interface Job {
  captureStart: string;
  // Scribe's words that only English uses, and only French (score.ts ONLY_EN, ONLY_FR), counted from
  // the archive (export.ts).
  en: number;
  fr: number;
  id: string;
  // Scribe's detected language (ISO 639-3).
  language: string;
  // Scribe's words in Latin and in Thai script, counted on the server.
  latin: number;
  seconds: number;
  speakers: number;
  thai: number;
}

// mixed is Thai with English; fr+en is French and English in one conversation.
export const GROUPS = ["en", "fr", "fr+en", "th", "mixed"] as const;
export type Group = (typeof GROUPS)[number];

// Clips per group, half with one speaker and half with several. English and French, alone or
// together, are the 90% the choice is made on; Thai and mixed only need enough to see whether a
// model holds up.
export const QUOTA: Record<Group, number> = {
  en: 18,
  fr: 18,
  "fr+en": 18,
  mixed: 8,
  th: 8,
};

const MIN_SECONDS = 45;

export function groupOf(job: Job): Group | null {
  const words = job.thai + job.latin;
  if (job.seconds < MIN_SECONDS || words / job.seconds < 0.5) {
    return null;
  }
  const thaiShare = job.thai / words;
  if (thaiShare > 0.15 && thaiShare < 0.85) {
    return "mixed";
  }
  if (job.language === "tha" && thaiShare >= 0.85) {
    return "th";
  }
  if (job.thai > 0 || !(job.language === "eng" || job.language === "fra")) {
    return null;
  }
  // Switching: between 15% and 85% of the one-language words are English, whichever Scribe named.
  const english = job.en / Math.max(1, job.en + job.fr);
  if (job.en + job.fr >= 10 && english > 0.15 && english < 0.85) {
    return "fr+en";
  }
  return job.language === "eng" ? "en" : "fr";
}

// A stable pseudo-random order: the hash of seed and id.
const rank = (seed: string, id: string) =>
  createHash("sha256").update(`${seed}:${id}`).digest("hex");

export interface Pick {
  group: Group;
  id: string;
  several: boolean;
}

// Each group's quota, alternating one speaker and several, so half and half while both last.
export function sample(jobs: Job[], seed = "1"): Pick[] {
  return GROUPS.flatMap((group) => {
    const ranked = jobs
      .filter((j) => groupOf(j) === group)
      .sort((a, b) => rank(seed, a.id).localeCompare(rank(seed, b.id)));
    const one = ranked.filter((j) => j.speakers === 1);
    const several = ranked.filter((j) => j.speakers > 1);
    const picked: Job[] = [];
    for (let i = 0; i < Math.max(one.length, several.length); i += 1) {
      picked.push(...[one[i], several[i]].filter((j) => j !== undefined));
    }
    return picked
      .slice(0, QUOTA[group])
      .map((j) => ({ group, id: j.id, several: j.speakers > 1 }));
  });
}

const MAX_SECONDS = 150;
const WINDOW = 120;

// The part of a job a clip keeps: all of it up to 150 s, else the 120 s holding the most words
// (the earliest of equals), cut between words so no word is split. Returns the range and its
// words, shifted to start at 0.
export function window(words: Word[], seconds: number) {
  if (seconds <= MAX_SECONDS) {
    return { end: seconds, start: 0, words };
  }
  const inside = (from: number) =>
    words.filter((w) => w.start >= from && w.end <= from + WINDOW);
  // Each window starts where a word's silence before it starts.
  const starts = words.map((_, i) => (i > 0 ? (words[i - 1]?.end ?? 0) : 0));
  const start = starts.reduce(
    (best, from) => (inside(from).length > inside(best).length ? from : best),
    0
  );
  const kept = inside(start);
  const end = kept.at(-1)?.end ?? start + WINDOW;
  return {
    end,
    start,
    words: kept.map((w) => ({
      ...w,
      end: w.end - start,
      start: w.start - start,
    })),
  };
}
