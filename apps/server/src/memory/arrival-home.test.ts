import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { clock, HOUR, iso } from "../core/clock";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as lifelog from "../sources/voice-server";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as voiceServerCall from "../sources/voice-server-call";
import { isHomeLaterOf, recordArrivalHome } from "./arrival-home";
import { HOME_ARRIVAL } from "./home-arrival";
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

afterEach(() => {
  rmSync(CORRECTIONS, { force: true });
  rmSync(HOME_ARRIVAL, { force: true });
});

test("a home Later is the home effect as written, never a mention", () => {
  expect(isHomeLaterOf("when I'm home")).toBe(true);
  expect(isHomeLaterOf("once I get back home")).toBe(true);
  expect(isHomeLaterOf("not when I'm home")).toBe(false);
  expect(isHomeLaterOf("about the home insurance")).toBe(false);
});

test("a Later that waits for home ends when read once he arrived home, not elsewhere; nothing of his is written", async () => {
  const start = clock();
  const later = (h: number) => new Date(start.getTime() + h * HOUR);
  spyOn(voiceServerCall, "voiceServerMissing").mockReturnValue(undefined);
  spyOn(lifelog, "whereAt").mockResolvedValue([stay(home, iso(0))]);
  const seen = spyOn(lifelog, "visits");
  await recordCorrection({
    home: true,
    kind: "deferred",
    ref: "dec_home",
    until: iso(later(24).getTime()),
  });
  const lines = () =>
    readFileSync(CORRECTIONS, "utf8").trim().split("\n").length;
  seen.mockResolvedValue([stay(cafe, iso(later(1).getTime()))]);
  await recordArrivalHome(later(2));
  expect(laterUntilOf("dec_home", later(2))).toBeDefined();
  seen.mockResolvedValue([
    stay(home, iso(later(3).getTime())),
    stay(cafe, iso(later(1).getTime())),
  ]);
  await recordArrivalHome(later(4));
  expect(laterUntilOf("dec_home", later(4))).toBeUndefined();
  expect(lines()).toBe(1);
  // Nothing waits any more: lifelog is not asked again.
  seen.mockClear();
  await recordArrivalHome(later(5));
  expect(seen).not.toHaveBeenCalled();
});
