import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendJsonl } from "../core/files";
import { LinkBatch } from "../records/link";
import { endingMarks, endingsNow, endingsRead } from "./endings";
import { drawEndingChecks, topUpFactChecks } from "./fact-checks";
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

/** Runs `drawEndingChecks` over `n` open promises each ended by a link, with `endings` on or off. */
async function drawn(n: number, on: boolean) {
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
    const first = await drawEndingChecks(NOW);
    const second = await drawEndingChecks(NOW);
    return { first, second };
  } finally {
    for (const s of spies) {
      s.mockRestore();
    }
  }
}

test("at most 3 ending checks are drawn a day, once each", async () => {
  reset();
  expect(await drawn(5, true)).toEqual({ first: 3, second: 0 });
  expect(
    openFactChecks(NOW.getTime()).map((s) => [s.ref, s.text, s.endedBy])
  ).toEqual([
    [promise(1), "Done? Call the shop 1", later(101)],
    [promise(2), "Done? Call the shop 2", later(102)],
    [promise(3), "Done? Call the shop 3", later(103)],
  ]);
  reset();
});

test("with endings off nothing is drawn and readers ignore links", async () => {
  reset();
  linked(2);
  expect(await drawn(2, false)).toEqual({ first: 0, second: 0 });
  const settings = await import("../core/settings");
  const off = spyOn(settings, "settings").mockReturnValue({} as never);
  try {
    expect(endingsRead(everything).maybe.size).toBe(0);
  } finally {
    off.mockRestore();
  }
  reset();
});

test("wrong removes those two ids' link for good and shows no further maybe on the step; right retires it", async () => {
  reset();
  linked(2);
  await drawn(2, true);
  recordFactCheckAnswer(promise(1), "false");
  recordFactCheckAnswer(promise(2), "true");
  // A later batch ties the same ids again: still refused, and the step shows no maybe.
  linked(1);
  const { endings, refused } = endingsNow(everything);
  expect(endings.has(promise(1))).toBe(false);
  expect([...refused]).toEqual([promise(1)]);
  const settings = await import("../core/settings");
  const on = spyOn(settings, "settings").mockReturnValue({
    endings: true,
  } as never);
  try {
    expect([...endingsRead(everything).maybe.keys()]).toEqual([promise(2)]);
  } finally {
    on.mockRestore();
  }
  // His right is the existing outdated word on the open step; his wrong corrects nothing.
  expect(
    readCorrections().map((c) => [
      c.kind,
      "observations" in c ? c.observations : [],
    ])
  ).toEqual([["outdated", [promise(2)]]]);
  reset();
});

test("ending checks never take a doubt's room", async () => {
  reset();
  await drawn(5, true);
  const doubts = await import("./doubts");
  const draw = spyOn(doubts, "drawFactChecks").mockResolvedValue([]);
  try {
    await topUpFactChecks(NOW.getTime());
    expect(draw).toHaveBeenCalledWith(5);
  } finally {
    draw.mockRestore();
  }
  reset();
});

test("the marks: a wrong ending is a live matter closed; his answers to ending checks are not the open side", async () => {
  reset();
  linked(2);
  await drawn(2, true);
  recordFactCheckAnswer(promise(1), "false");
  recordFactCheckAnswer(promise(2), "true");
  expect(endingMarks()).toMatchObject({
    closed: 2,
    liveClosed: 1,
    open: 0,
    pass: false,
    staleOpen: 0,
  });
  reset();
});
