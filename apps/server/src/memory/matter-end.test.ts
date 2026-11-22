import { expect, test } from "bun:test";
import { matterEndOf } from "./matter-end";
import type { MatterStepNow } from "./matter-read";

const step = (ref: string, at: string, over: Partial<MatterStepNow> = {}) =>
  ({
    at,
    day: at.slice(0, 10),
    kind: "to_do",
    quote: "",
    ref,
    text: "",
    ...over,
  }) as MatterStepNow;

test("a closed matter ends when its last step ended, or with its last step when done by quiet; open ones have no end", () => {
  const done = step("a", "2026-10-01T10:00:00.000Z", {
    ending: { at: "2026-10-03T10:00:00.000Z", by: "todo_item" },
  });
  const later = step("b", "2026-10-04T10:00:00.000Z", { kind: "episode" });
  const closed = { open: false, openSteps: [], status: "done" as const };
  expect(matterEndOf({ ...closed, steps: [done, later] })).toEqual({
    at: "2026-10-03T10:00:00.000Z",
    outcome: "done",
  });
  expect(matterEndOf({ ...closed, steps: [later] })).toEqual({
    at: "2026-10-04T10:00:00.000Z",
    outcome: "done",
  });
  expect(
    matterEndOf({ ...closed, open: true, status: "moving", steps: [later] })
  ).toBeUndefined();
});
