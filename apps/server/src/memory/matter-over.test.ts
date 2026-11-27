import { expect, test } from "bun:test";
import type { Observation } from "../records/observation";
import { type MatterRecords, matterBookOf, openStepsOf } from "./matter-read";
import { OWNER } from "./read-truth";

// His word of 21 Nov 2026: a matter Life reads over is closed as probably done, not left open; anything newer reopens it.
// Made-up matter: a parcel to collect.

const todo = (n: number) =>
  ({
    area: null,
    at: `2026-10-1${n}T10:00:00.000Z`,
    date: `2026-10-1${n}`,
    id: `obs_00000000000${n}`,
    importance: 3,
    quote: "collect the parcel",
    speaker: OWNER,
    subjects: [OWNER],
    text: "Collect the parcel",
    type: "to_do",
    unit: `unit_00000000000${n}`,
    when: null,
  }) as Observation;
const OBS = [todo(1), todo(2)];
const LINE = {
  areas: [],
  id: "matter_000000000001",
  name: "Collect the parcel",
  projects: [],
  steps: OBS.map((o) => ({ ref: o.id })),
};
const STEPS = OBS.map((o) => o.id);
const bookWithRecords = (given: Partial<MatterRecords>) =>
  matterBookOf(
    { matters: [LINE], offered: new Set() },
    {
      current: new Set(),
      directions: [],
      episodeOf: new Map(),
      icons: [],
      important: [],
      isMailer: () => false,
      ledger: [],
      linkEndings: new Map(),
      observations: OBS,
      projects: [],
      refOf: (r) => r,
      retired: new Map(),
      todoItems: [],
      ...given,
    },
    "2026-10-20"
  )[0];
const bookWith = (directions: MatterRecords["directions"]) =>
  bookWithRecords({ directions });
const over = (steps = STEPS) => ({
  at: "2026-10-20T02:00:00Z",
  by: "life" as const,
  endingRecords: ["unit_000000000009"],
  goal: "Parcel collected",
  steps,
});

test("Life's latest direction reading a matter over closes it as probably done until something newer comes", () => {
  expect(bookWith([])).toMatchObject({ open: true });
  expect(bookWith([over()])).toMatchObject({
    important: false,
    open: false,
    status: "probably_done",
  });
  // A reading that cites no record is no evidence: open (his rule of 27 Nov 2026).
  expect(bookWith([{ ...over(), endingRecords: [] }])?.open).toBe(true);
  // A step the draft never saw: the reading is out of date, the matter is open again.
  expect(bookWith([over(STEPS.slice(0, 1))])?.open).toBe(true);
  // His own next step is never Life's reading.
  const his = {
    at: "2026-10-20T03:00:00Z",
    by: "owner" as const,
    nextStep: { kind: "do" as const, text: "Collect it" },
    steps: STEPS,
  };
  expect(bookWith([over(), his])?.open).toBe(true);
});

// Nav v3 (22 Nov 2026): "It's done" on a Looks done matter is his `outdated` word on the matter (`correctMatter`), which
// closes `openStepsOf`: the steps a link ended, and those of a matter Life reads over, then reads done.
test("his word on a Looks done matter closes its steps and reads done, whether a link or Life's reading made it look done", () => {
  const his = (ids: string[]) =>
    new Map(
      ids.map((id) => [id, { at: "2026-10-20T09:00:00Z", why: "outdated" }])
    );
  const byDirection = bookWith([over()]);
  expect(openStepsOf(byDirection as never).map((s) => s.ref)).toEqual(STEPS);
  expect(
    bookWithRecords({ directions: [over()], retired: his(STEPS) })?.status
  ).toBe("done");
  const linked = new Map(
    STEPS.map((id) => [
      id,
      { at: "2026-10-18T09:00:00Z", later: "ep_000000000009", quote: "Got it" },
    ])
  );
  const byLink = bookWithRecords({ linkEndings: linked });
  expect(byLink?.status).toBe("probably_done");
  expect(openStepsOf(byLink as never).map((s) => s.ref)).toEqual(STEPS);
  expect(
    bookWithRecords({ linkEndings: linked, retired: his(STEPS) })?.status
  ).toBe("done");
});
