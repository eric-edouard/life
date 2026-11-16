import { expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { LOCK, locked } from "./memory-lock";
import {
  afterNightDue,
  decide,
  type JobState,
  nextNight,
  quotaLine,
  reserved,
} from "./schedule";
import { localTime } from "./zones";

const day = "2026-10-15";
const st = (status: "ok" | "failed", attempts = 1, date = day): JobState => ({
  attempts,
  date,
  lastAt: "",
  status,
});

test("the guard runs only after 05:00, once a day, three tries at most", () => {
  expect(decide(4, day, undefined)).toBe("skip");
  expect(decide(5, day, undefined)).toBe("run");
  expect(decide(5, day, st("ok"))).toBe("skip");
  expect(decide(8, day, st("failed", 2))).toBe("run");
  expect(decide(8, day, st("failed", 3))).toBe("skip");
  expect(decide(8, day, st("ok", 0, "2026-10-14"))).toBe("run");
});

test("the backup is due once the night is done for the day or from 09:00, once a day, three tries at most", () => {
  expect(afterNightDue(4, day, undefined, undefined)).toBe(false);
  expect(afterNightDue(6, day, undefined, undefined)).toBe(false); // the night has not run
  expect(afterNightDue(6, day, st("failed", 1), undefined)).toBe(false); // the night retries first
  expect(afterNightDue(8, day, undefined, undefined)).toBe(false);
  expect(afterNightDue(9, day, undefined, undefined)).toBe(true); // the night never finished: back up anyway
  expect(afterNightDue(6, day, st("ok"), undefined)).toBe(true);
  expect(afterNightDue(6, day, st("failed", 3), undefined)).toBe(true); // the night gave up: back up anyway
  expect(afterNightDue(6, day, st("ok"), st("ok"))).toBe(false);
  expect(afterNightDue(7, day, st("ok"), st("failed", 2))).toBe(true);
  expect(afterNightDue(7, day, st("ok"), st("failed", 3))).toBe(false);
  expect(afterNightDue(6, day, st("ok"), st("ok", 0, "2026-10-14"))).toBe(true);
});

test("the next windows: earliest and expected by the next tick, with why", () => {
  const at = (h: number, m = 0, d = 15) => new Date(2026, 9, d, h, m);
  const iso = (d: Date) => d.toISOString();
  expect(nextNight(at(1), day, undefined)).toMatchObject({
    earliest: iso(at(5)),
    latest: iso(at(5, 30)),
    why: "waits for 05:00",
  });
  expect(nextNight(at(8), day, st("failed", 2)).why).toBe(
    "retry 3 of 3 after a failure"
  );
  expect(nextNight(at(8), day, st("failed", 3))).toMatchObject({
    earliest: iso(at(5, 0, 16)),
    why: "3 failures today: no more tries until tomorrow",
  });
  expect(nextNight(at(8), day, st("ok")).earliest).toBe(iso(at(5, 0, 16)));
});

test("two runs at once: exactly one takes the lock, the other gets null without running", async () => {
  const run = () => locked(() => Bun.sleep(20).then(() => "ran"));
  const got = await Promise.all([run(), run()]);
  expect(got.filter((g) => g === null)).toHaveLength(1);
  expect(got).toContain("ran");
});

test("a lock left by a dead pid, or from before the boot (its pid reused), is taken over", async () => {
  writeFileSync(LOCK, "999999"); // above macOS's highest pid: never alive
  expect(await locked(async () => "ran")).toBe("ran");
  writeFileSync(LOCK, String(process.pid)); // alive, but written before the boot
  utimesSync(LOCK, new Date(0), new Date(0));
  expect(await locked(async () => "ran")).toBe("ran");
});

test("over 75% of his Codex quota what can wait waits, until the quota resets", () => {
  const at = (h: number, d = 21) => new Date(2026, 9, d, h, 30);
  const quota = (used: number) => ({
    resetsAt: at(7, 27).toISOString(),
    used,
  });
  expect(reserved(quota(80), at(14).getTime())).toBe(true);
  expect(reserved(quota(75), at(14).getTime())).toBe(false);
  expect(reserved(undefined)).toBe(false); // unread: nothing waits
  // A reading from before its reset holds nothing.
  expect(reserved(quota(99), at(14, 28).getTime())).toBe(false);
  // At the tick's own time, never the test's: the reset is a fixed date that the real clock passes.
  expect(quotaLine(quota(80), at(14).getTime())).toBe(
    `Codex quota: 80% used, resets ${localTime(at(7, 27).toISOString())}: over 75%, imports and evals wait`
  );
  expect(quotaLine({ resetsAt: null, used: 12 })).toBe("Codex quota: 12% used");
  expect(quotaLine(undefined)).toBe("Codex quota: not read");
});
