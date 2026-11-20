import { expect, test } from "bun:test";
import { type AgentHold, isHeldOf, MATTER_OVER_OUTCOME } from "./held-matters";

// The one rule of "held", for the hand-out and the new matter check alike. Made-up steps and agents.

const END = "2026-11-10T09:00:00.000Z";
const BEFORE = "2026-11-09T09:00:00.000Z";
const AFTER = "2026-11-11T09:00:00.000Z";
const hold = (over: Partial<AgentHold> = {}): AgentHold => ({
  endedAt: END,
  kind: "handed_out",
  outcome: "nothing left for me",
  project: null,
  step: "obs_h1",
  whyNotStarted: null,
  ...over,
});
const matter = (newest: string) => ({
  steps: [
    { at: BEFORE, ref: "obs_h1" },
    { at: newest, ref: "obs_h2" },
  ],
});
const isHeld = (h: AgentHold, newest = BEFORE) => isHeldOf([h])(matter(newest));

test("an active or stopped agent holds its matter, however new its steps", () => {
  expect(isHeld(hold({ endedAt: null }), AFTER)).toBe(true);
});

// Finding 3 of the action pipeline review (20 Nov 2026): a try was remembered for 7 days only, so a matter nobody moved
// was handed out again a week later and he was asked the same thing twice.
test("an ended agent holds its matter until it has a step newer than its end, however long ago it ended", () => {
  expect(isHeld(hold())).toBe(true);
  expect(isHeld(hold(), END)).toBe(true);
  expect(isHeld(hold(), AFTER)).toBe(false);
  expect(isHeld(hold({ kind: "asked" }))).toBe(true);
});

test("an agent ended because its matter looked over holds nothing", () => {
  expect(isHeld(hold({ outcome: MATTER_OVER_OUTCOME }))).toBe(false);
});

test("one he asked for that never began holds nothing; a hand-out that never began holds like a try", () => {
  expect(isHeld(hold({ kind: "asked", whyNotStarted: "test" }))).toBe(false);
  expect(isHeld(hold({ whyNotStarted: "test" }))).toBe(true);
  expect(isHeld(hold({ whyNotStarted: "test" }), AFTER)).toBe(false);
});

test("an anchor on another matter's step holds nothing here", () => {
  expect(isHeld(hold({ endedAt: null, step: "obs_other" }))).toBe(false);
});
