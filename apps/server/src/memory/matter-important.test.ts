import { expect, test } from "bun:test";
import type { Observation } from "../records/observation";
import { isRunning, type MatterRecords, matterBookOf } from "./matter-read";
import { OWNER } from "./read-truth";

// His important mark (20 Nov 2026): his word only, on or off, pinned to the matter's steps like his directions.

const promise = {
  area: null,
  at: "2026-10-12T10:00:00.000Z",
  date: "2026-10-12",
  id: "obs_000000000005",
  importance: 3,
  quote: "I'll call the shop",
  speaker: OWNER,
  subjects: [OWNER, "person:gran"],
  text: "Call the shop",
  type: "promise",
  unit: "unit_000000000005",
  when: null,
} as unknown as Observation;
const line = {
  areas: [],
  id: "matter_aaaaaaaaaaaa",
  name: "Mend Gran's watch",
  projects: [],
  steps: [{ ref: promise.id }],
};
const pin = (day: string, important: boolean) => ({
  at: `2026-10-${day}T09:00:00.000Z`,
  important,
  steps: [promise.id],
});
const bookOf = (
  important: MatterRecords["important"],
  { id = line.id, retired = new Map(), today = "2026-10-20" } = {}
) =>
  matterBookOf(
    { matters: [{ ...line, id }], offered: new Set() },
    {
      current: new Set(),
      directions: [],
      episodeOf: new Map(),
      important,
      isMailer: () => false,
      ledger: [],
      linkEndings: new Map(),
      observations: [promise],
      refOf: (r) => r,
      retired,
      todoItems: [],
    },
    today
  )[0];

test("the latest mark for a matter wins, by instant, whatever the order written", () => {
  expect(bookOf([])?.important).toBe(false);
  expect(bookOf([pin("13", true)])?.important).toBe(true);
  expect(bookOf([pin("14", false), pin("13", true)])?.important).toBe(false);
  expect(
    bookOf([pin("13", false), pin("15", true), pin("14", false)])?.important
  ).toBe(true);
});

test("a re-group keeps the mark: it finds its matter by its steps", () => {
  expect(
    bookOf([pin("13", true)], { id: "matter_bbbbbbbbbbbb" })?.important
  ).toBe(true);
});

test("a done matter reads unmarked; a marked dormant one stays running", () => {
  const done = new Map([
    [promise.id, { at: "2026-10-19T09:00:00Z", why: "outdated" }],
  ]);
  const ended = bookOf([pin("13", true)], { retired: done });
  expect(ended?.open).toBe(false);
  expect(ended?.important).toBe(false);
  const quiet = bookOf([], { today: "2027-01-20" });
  expect(quiet?.status).toBe("dormant");
  expect(isRunning(quiet as NonNullable<typeof quiet>)).toBe(false);
  const kept = bookOf([pin("13", true)], { today: "2027-01-20" });
  expect(kept?.status).toBe("dormant");
  expect(isRunning(kept as NonNullable<typeof kept>)).toBe(true);
});
