import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendJsonl } from "../core/files";
import { LinkBatch } from "../records/link";
import { endingMarks, endingsNow, endingsRead } from "./endings";
import { askEndings } from "./fact-checks";
import {
  FACT_CHECK_ANSWERS,
  FACT_CHECKS,
  LINKS,
  openFactChecks,
  readCorrections,
  recordFactCheckAnswer,
} from "./memory-files";

const pad = (n: number) => String(n).padStart(12, "0");
const promise = (n: number) => `obs_${pad(n)}`;
const later = (n: number) => `ep_${pad(n)}`;
const NOW = new Date("2026-11-14T10:00:00.000Z");

const reset = () => {
  for (const f of [FACT_CHECKS, FACT_CHECK_ANSWERS, LINKS]) {
    rmSync(f, { force: true });
  }
};
/** One batch: each promise 1..n ended by the episode 100 + n. */
const linked = (n: number) =>
  appendJsonl(LINKS, LinkBatch, [
    {
      at: "2026-11-10T00:00:00.000Z",
      links: Array.from({ length: n }, (_, i) => ({
        earlier: promise(i + 1),
        later: later(100 + i + 1),
        quote: `done ${i + 1}`,
        relation: "ends" as const,
      })),
      madeBy: {
        engine: "claude",
        model: "m",
        prompt: "memory-links.v2",
        run: "r",
      },
      offered: Array.from({ length: n }, (_, i) => later(100 + i + 1)),
      open: Array.from({ length: n }, (_, i) => promise(i + 1)),
      schemaVersion: 1,
      subject: "matter_000000000001",
    },
  ]);
const everything = () => true;

/** Runs `askEndings` over `n` open promises each ended by a link, with `endings` on or off. */
async function asked(n: number, on: boolean) {
  const settings = await import("../core/settings");
  const matters = await import("./matters");
  const on_ = spyOn(settings, "settings").mockReturnValue(
    (on ? { endings: true } : {}) as never
  );
  const records = spyOn(matters, "readMatterRecords").mockResolvedValue({
    maybe: new Map(
      Array.from({ length: n }, (_, i) => [
        promise(i + 1),
        {
          at: `2026-11-10T00:00:0${i}.000Z`,
          earlier: promise(i + 1),
          later: later(100 + i + 1),
          quote: `done ${i + 1}`,
          relation: "ends" as const,
        },
      ])
    ),
    observations: Array.from({ length: n }, (_, i) => ({
      date: "2026-11-01",
      id: promise(i + 1),
      modality: "plan",
      source: { channel: "whatsapp" },
      subjects: ["person:gran"],
      text: `Call the shop ${i + 1}`,
      unit: "unit_000000000001",
    })),
  } as never);
  const spies = [on_, records];
  try {
    const first = await askEndings(NOW);
    const second = await askEndings(NOW);
    return { first, second };
  } finally {
    for (const s of spies) {
      s.mockRestore();
    }
  }
}

test("at most 3 endings are asked a day, once each, in conversation", async () => {
  reset();
  expect(await asked(5, true)).toEqual({ first: 3, second: 0 });
  expect(
    openFactChecks(NOW.getTime()).map((s) => [s.ref, s.text, s.later])
  ).toEqual([
    [promise(1), "Done? Call the shop 1", later(101)],
    [promise(2), "Done? Call the shop 2", later(102)],
    [promise(3), "Done? Call the shop 3", later(103)],
  ]);
  reset();
});

test("with endings off nothing is asked and readers ignore links", async () => {
  reset();
  linked(2);
  expect(await asked(2, false)).toEqual({ first: 0, second: 0 });
  const settings = await import("../core/settings");
  const off = spyOn(settings, "settings").mockReturnValue({} as never);
  try {
    const read = endingsRead(everything);
    expect([read.confirmed.size, read.maybe.size]).toEqual([0, 0]);
  } finally {
    off.mockRestore();
  }
  reset();
});

test("wrong removes that link for good, and corrects nothing; right is his word", async () => {
  reset();
  linked(2);
  await asked(2, true);
  recordFactCheckAnswer(promise(1), "false");
  recordFactCheckAnswer(promise(2), "true");
  // A later batch ties the same pair again: still refused.
  linked(1);
  const { confirmed, endings } = endingsNow(everything);
  expect(endings.has(promise(1))).toBe(false);
  expect([...confirmed]).toEqual([promise(2)]);
  // His answers are about the links: the promises themselves stay as they were.
  expect(readCorrections()).toEqual([]);
  reset();
});

test("the marks: a wrong ending is a live matter closed; an outdated thing no link found is a stale one left open", async () => {
  reset();
  linked(2);
  await asked(2, true);
  recordFactCheckAnswer(promise(1), "false");
  recordFactCheckAnswer(promise(2), "true");
  expect(endingMarks()).toMatchObject({
    closed: 2,
    liveClosed: 1,
    pass: false,
    staleOpen: 0,
  });
  reset();
});
