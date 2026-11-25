import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { clock, HOUR, iso } from "../core/clock";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as lifelog from "../sources/lifelog";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as lifelogCall from "../sources/lifelog-call";
import { endLatersAtHome } from "./arrival-home";
import { laterUntilOf } from "./matters";
import { CORRECTIONS, recordCorrection } from "./memory-files";

// Made-up places throughout.
const home = { latitude: 48.85, longitude: 2.35 };
const cafe = { latitude: 48.86, longitude: 2.37 };
const stay = (p: typeof home, arrivedAt: string) => ({
  ...p,
  arrivedAt,
  leftAt: null,
  place: null,
});

afterEach(() => rmSync(CORRECTIONS, { force: true }));

test("a Later that waits for home ends at his next arrival home, not at an arrival elsewhere", async () => {
  const start = clock();
  const later = (h: number) => new Date(start.getTime() + h * HOUR);
  spyOn(lifelogCall, "lifelogMissing").mockReturnValue(undefined);
  spyOn(lifelog, "whereAt").mockResolvedValue([stay(home, iso(0))]);
  const seen = spyOn(lifelog, "visits");
  await recordCorrection({
    home: true,
    kind: "deferred",
    ref: "dec_home",
    until: iso(later(24).getTime()),
  });
  seen.mockResolvedValue([stay(cafe, iso(later(1).getTime()))]);
  expect(await endLatersAtHome(later(2))).toBe(0);
  expect(laterUntilOf("dec_home", later(2))).toBeDefined();
  seen.mockResolvedValue([
    stay(home, iso(later(3).getTime())),
    stay(cafe, iso(later(1).getTime())),
  ]);
  expect(await endLatersAtHome(later(4))).toBe(1);
  expect(laterUntilOf("dec_home", later(4))).toBeUndefined();
  // Nothing waits any more: lifelog is not asked again.
  seen.mockClear();
  expect(await endLatersAtHome(later(5))).toBe(0);
  expect(seen).not.toHaveBeenCalled();
});
