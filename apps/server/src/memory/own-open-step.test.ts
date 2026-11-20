import { expect, test } from "bun:test";
import type { Observation } from "../records/observation";
import { type MatterRecords, matterBookOf } from "./matter-read";
import { OWNER } from "./read-truth";

// `hasOwnOpenStep`: an open step he said himself. Made-up people and matters.

const STRANGER = "unknown:stranger@example.test";
const said = (n: number, speaker: string) =>
  ({
    area: null,
    at: "2026-10-10T10:00:00.000Z",
    date: "2026-10-10",
    id: `obs_${String(n).padStart(12, "0")}`,
    importance: 3,
    quote: "q",
    speaker,
    subjects: [speaker],
    text: "t",
    type: "to_do",
    unit: `unit_${String(n).padStart(12, "0")}`,
    when: null,
  }) as Observation;

const hasOwnOpenStep = (...list: Observation[]) =>
  matterBookOf(
    {
      matters: [
        {
          areas: [],
          id: "matter_bbbbbbbbbbbb",
          name: "Test errand",
          projects: [],
          steps: list.map((o) => ({ ref: o.id })),
        },
      ],
      offered: new Set(),
    },
    {
      current: new Set(),
      directions: [],
      episodeOf: new Map(),
      icons: [],
      important: [],
      isMailer: () => false,
      ledger: [],
      linkEndings: new Map(),
      observations: list,
      refOf: (r) => r,
      retired: new Map(),
      todoItems: [],
    } satisfies MatterRecords,
    "2026-10-20"
  )[0]?.hasOwnOpenStep;

test("an open step is his own when he spoke it, never when only an unknown sender did", () => {
  expect(hasOwnOpenStep(said(21, STRANGER))).toBe(false);
  expect(hasOwnOpenStep(said(21, STRANGER), said(22, OWNER))).toBe(true);
});
