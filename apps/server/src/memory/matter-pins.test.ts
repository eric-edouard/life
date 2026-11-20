import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendJsonl } from "../core/files";
import { MatterDirectionBatch } from "../records/matter";
import { Correction, type Observation } from "../records/observation";
import {
  chosenIconsOf,
  isRunning,
  type MatterRecords,
  matterBookOf,
  matterFinderOf,
} from "./matter-read";
import { readMatterPins } from "./matters";
import { CORRECTIONS, MATTER_DIRECTIONS } from "./memory-files";
import { OWNER } from "./read-truth";

// His marks on a matter (20 Nov 2026), his word only, pinned to the matter's steps like his directions: important, on
// or off, and his icon, a key or null (Life picks again).

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
  {
    directions = [] as MatterRecords["directions"],
    icons = [] as MatterRecords["icons"],
    id = line.id,
    retired = new Map(),
    today = "2026-10-20",
  } = {}
) =>
  matterBookOf(
    { matters: [{ ...line, id }], offered: new Set() },
    {
      current: new Set(),
      directions,
      episodeOf: new Map(),
      icons,
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

const iconPin = (
  day: string,
  icon: MatterRecords["icons"][number]["icon"]
) => ({
  at: `2026-10-${day}T09:00:00.000Z`,
  icon,
  steps: [promise.id],
});

test("his latest icon wins over older keys, by instant; a null gives it back to Life; a later pick wins again", () => {
  expect(bookOf([])?.ownerIcon).toBeUndefined();
  expect(
    bookOf([], { icons: [iconPin("14", "tools"), iconPin("13", "key")] })
      ?.ownerIcon
  ).toBe("tools");
  expect(
    bookOf([], { icons: [iconPin("13", "tools"), iconPin("14", null)] })
      ?.ownerIcon
  ).toBeUndefined();
  expect(
    bookOf([], {
      icons: [
        iconPin("15", "gift"),
        iconPin("13", "tools"),
        iconPin("14", null),
      ],
    })?.ownerIcon
  ).toBe("gift");
  // A re-group keeps it.
  expect(
    bookOf([], { icons: [iconPin("13", "tools")], id: "matter_bbbbbbbbbbbb" })
      ?.ownerIcon
  ).toBe("tools");
});

afterEach(() => {
  rmSync(CORRECTIONS, { force: true });
  rmSync(MATTER_DIRECTIONS, { force: true });
});

test("one read of his corrections gives every pin: Life's drafts first, his partial direction, a false mark, his icons", () => {
  const at = (day: string) => `2026-10-${day}T09:00:00.000Z`;
  const steps = [promise.id];
  appendJsonl(MATTER_DIRECTIONS, MatterDirectionBatch, [
    {
      at: at("12"),
      directions: [
        {
          goal: "The watch is back",
          nextStep: { kind: "do", text: "Call the shop" },
          steps,
        },
      ],
      madeBy: {
        engine: "claude",
        model: "m",
        prompt: "memory-matter-directions.v1",
        run: "r",
      },
      schemaVersion: 1,
    },
  ]);
  // Written out of order: the instants decide, never the order of the lines.
  appendJsonl(CORRECTIONS, Correction, [
    {
      at: at("16"),
      icon: "tools",
      kind: "matter-icon",
      schemaVersion: 1,
      steps,
    },
    {
      at: at("13"),
      goal: "Gran wears it again",
      kind: "matter-direction",
      schemaVersion: 1,
      steps,
    },
    {
      at: at("15"),
      important: true,
      kind: "matter-important",
      schemaVersion: 1,
      steps,
    },
    { at: at("14"), icon: null, kind: "matter-icon", schemaVersion: 1, steps },
    {
      at: at("17"),
      important: false,
      kind: "matter-important",
      schemaVersion: 1,
      steps,
    },
  ]);
  const pins = readMatterPins();
  expect(pins.directions.map((d) => [d.by, d.goal, d.nextStep?.text])).toEqual([
    ["life", "The watch is back", "Call the shop"],
    ["owner", "Gran wears it again", undefined],
  ]);
  expect(pins.important.map((p) => p.important)).toEqual([true, false]);
  expect(pins.icons.map((p) => p.icon)).toEqual(["tools", null]);
  const v = bookOf(pins.important, { ...pins, id: "matter_bbbbbbbbbbbb" });
  expect(v?.goal).toMatchObject({ by: "owner", text: "Gran wears it again" });
  expect(v?.nextStep).toMatchObject({ by: "life", text: "Call the shop" });
  expect(v?.important).toBe(false);
  expect(v?.ownerIcon).toBe("tools");
});

// #743's confirm round: the matter's id stored with a pin breaks a tie only, never outweighs its steps.
test("a pin goes to the matter holding the most of its steps; its stored matter id only breaks a tie", () => {
  const picked = {
    at: "2026-10-13T09:00:00.000Z",
    icon: "paper" as const,
    matter: "matter_aaaaaaaaaaaa",
    steps: ["ep_000000000001", "obs_000000000001", "obs_000000000002"],
  };
  const iconsOf = (book: { id: string; steps: { ref: string }[] }[]) =>
    chosenIconsOf(matterFinderOf(book), [picked]);
  const steps = (...refs: string[]) => refs.map((ref) => ({ ref }));
  // A re-group left the episode in the picked matter and both observations in another: the steps win.
  expect([
    ...iconsOf([
      { id: "matter_aaaaaaaaaaaa", steps: steps("ep_000000000001") },
      {
        id: "matter_bbbbbbbbbbbb",
        steps: steps("obs_000000000001", "obs_000000000002"),
      },
    ]),
  ]).toEqual([["matter_bbbbbbbbbbbb", "paper"]]);
  // As many of its steps each: the one picked, though it is the bigger.
  expect([
    ...iconsOf([
      { id: "matter_bbbbbbbbbbbb", steps: steps("ep_000000000001") },
      {
        id: "matter_aaaaaaaaaaaa",
        steps: steps("ep_000000000001", "obs_000000000009"),
      },
    ]),
  ]).toEqual([["matter_aaaaaaaaaaaa", "paper"]]);
});
