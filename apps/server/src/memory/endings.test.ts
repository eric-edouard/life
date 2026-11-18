import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendJsonl } from "../core/files";
import { FactCheck } from "../records/fact-check";
import { LinkBatch } from "../records/link";
import { checksNow } from "./checks";
import { endingsNow, endingsRead } from "./endings";
import { recordFactCheckAnswer } from "./fact-checks";
import {
  answeredFactChecks,
  FACT_CHECK_ANSWERS,
  FACT_CHECKS,
  LINKS,
  readCorrections,
  readFactChecks,
} from "./memory-files";

const pad = (n: number) => String(n).padStart(12, "0");
const promise = (n: number) => `obs_${pad(n)}`;
const later = (n: number) => `ep_${pad(n)}`;

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

/** Makes `n` open promises each ended by a link current for `readMatterRecords`; returns what undoes it. */
async function ended(n: number) {
  const matters = await import("./matters");
  const records = spyOn(matters, "readMatterRecords").mockResolvedValue({
    episodes: [],
    linkEndings: new Map(
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
      importance: 3,
      modality: "plan",
      source: { channel: "whatsapp" },
      subjects: ["person:gran"],
      text: `Call the shop ${i + 1}`,
      unit: "unit_000000000001",
    })),
    retired: new Map(),
    todoItems: [],
  } as never);
  return () => records.mockRestore();
}

test("an answer to an ending writes its check first, then the answer; a second answer is refused", async () => {
  reset();
  const undo = await ended(2);
  const files = await import("../core/files");
  const append = spyOn(files, "appendJsonl");
  try {
    await recordFactCheckAnswer(promise(1), "outdated");
    await expect(
      recordFactCheckAnswer(promise(1), "false", "changed my mind")
    ).rejects.toThrow("no open ending check");
  } finally {
    undo();
  }
  const written = append.mock.calls.map(([path]) => path);
  append.mockRestore();
  expect(written).toEqual([FACT_CHECKS, FACT_CHECK_ANSWERS]);
  expect(readFactChecks().map((s) => [s.ref, s.text, s.endedBy])).toEqual([
    [promise(1), "Life thinks this is done: Call the shop 1", later(101)],
  ]);
  reset();
});

test("an old unanswered doubt line on the same ref gets no ending answer, and never an eval fact from one", async () => {
  reset();
  appendJsonl(FACT_CHECKS, FactCheck, [
    {
      at: "2026-10-01T10:00:00.000Z",
      date: "2026-09-30",
      group: "episodes",
      kind: "fact",
      ref: promise(1),
      schemaVersion: 1,
      source: "whatsapp",
      text: "Call the shop 1",
      units: ["unit_000000000001"],
    },
  ]);
  const undo = await ended(1);
  try {
    await expect(recordFactCheckAnswer(promise(1), "false")).rejects.toThrow(
      "no open ending check"
    );
    expect((await checksNow()).some((c) => c.ref === promise(1))).toBe(false);
  } finally {
    undo();
  }
  expect(answeredFactChecks()).toEqual([]);
  reset();
});

test("wrong removes those two ids' link for good and ends the step no more; right retires it", async () => {
  reset();
  linked(2);
  const undo = await ended(2);
  await recordFactCheckAnswer(promise(1), "false");
  await recordFactCheckAnswer(promise(2), "outdated");
  undo();
  // A later batch ties the same ids again: still refused, and ends the step no more.
  linked(1);
  const { endings, refused } = endingsNow(everything);
  expect(endings.has(promise(1))).toBe(false);
  expect([...refused]).toEqual([promise(1)]);
  expect([...endingsRead(everything).linkEndings.keys()]).toEqual([promise(2)]);
  // His right is the existing outdated word on the open step; his wrong corrects nothing.
  expect(
    readCorrections().map((c) => [
      c.kind,
      "observations" in c ? c.observations : [],
    ])
  ).toEqual([["outdated", [promise(2)]]]);
  reset();
});
