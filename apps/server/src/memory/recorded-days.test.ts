import { expect, test } from "bun:test";
import { recordedDaysOf } from "./recorded-days";

test("the recorded days are the local days the stretches touch: one over midnight gives both, each day once", () => {
  expect(
    recordedDaysOf([
      {
        endAt: "2026-11-10T07:00:00.000Z",
        startAt: "2026-11-10T06:00:00.000Z",
      },
      {
        endAt: "2026-11-10T09:00:00.000Z",
        startAt: "2026-11-10T08:00:00.000Z",
      },
      // Two days on, from one noon to the next: both days, in any zone.
      {
        endAt: "2026-11-13T12:00:00.000Z",
        startAt: "2026-11-12T12:00:00.000Z",
      },
    ])
  ).toEqual(["2026-11-10", "2026-11-12", "2026-11-13"]);
});
