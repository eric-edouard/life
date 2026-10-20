import { expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import {
  afterWeek,
  backfillWeek,
  backupDue,
  decide,
  LOCK,
  locked,
  middayDue,
  type NightState,
  nextMidday,
  nextNight,
} from "./guard";

const day = "2026-10-15";
const st = (status: "ok" | "failed", attempts = 1, date = day): NightState => ({
  attempts,
  date,
  lastAt: "",
  status,
});

test("the guard runs only after 02:00, once a day, three tries at most", () => {
  expect(decide(1, day, undefined)).toBe("skip");
  expect(decide(2, day, undefined)).toBe("run");
  expect(decide(2, day, st("ok"))).toBe("skip");
  expect(decide(5, day, st("failed", 2))).toBe("run");
  expect(decide(5, day, st("failed", 3))).toBe("skip");
  expect(decide(5, day, st("ok", 0, "2026-10-14"))).toBe("run");
});

test("the backup is due once the night is done for the day or from 06:00, once a day, three tries at most", () => {
  expect(backupDue(1, day, undefined, undefined)).toBe(false);
  expect(backupDue(3, day, undefined, undefined)).toBe(false); // the night has not run
  expect(backupDue(3, day, st("failed", 1), undefined)).toBe(false); // the night retries first
  expect(backupDue(6, day, undefined, undefined)).toBe(true); // the night never finished: back up anyway
  expect(backupDue(3, day, st("ok"), undefined)).toBe(true);
  expect(backupDue(3, day, st("failed", 3), undefined)).toBe(true); // the night gave up: back up anyway
  expect(backupDue(3, day, st("ok"), st("ok"))).toBe(false);
  expect(backupDue(4, day, st("ok"), st("failed", 2))).toBe(true);
  expect(backupDue(4, day, st("ok"), st("failed", 3))).toBe(false);
  expect(backupDue(3, day, st("ok"), st("ok", 0, "2026-10-14"))).toBe(true);
});

test("a midday run is due at the first tick after 13:00 and after 19:00, once each", () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 15, h, m);
  const used = (h: number, m = 0) => at(h, m).toISOString();
  expect(middayDue(at(12, 59), undefined)).toBe(false);
  expect(middayDue(at(13), undefined)).toBe(true);
  expect(middayDue(at(13, 30), used(13))).toBe(false);
  expect(middayDue(at(18, 30), used(13, 5))).toBe(false);
  expect(middayDue(at(19, 1), used(13, 5))).toBe(true);
  expect(middayDue(at(19, 31), used(19, 1))).toBe(false);
  expect(middayDue(at(13, 1), new Date(2026, 9, 14, 19, 5).toISOString())).toBe(
    true
  );
});

test("the next windows: earliest and expected by the next tick, with why", () => {
  const at = (h: number, m = 0, d = 15) => new Date(2026, 9, d, h, m);
  const iso = (d: Date) => d.toISOString();
  expect(nextNight(at(1), day, undefined)).toMatchObject({
    earliest: iso(at(2)),
    latest: iso(at(2, 30)),
  });
  expect(nextNight(at(5), day, st("failed", 2)).why).toBe(
    "retry 3 of 3 after a failure"
  );
  expect(nextNight(at(5), day, st("failed", 3))).toMatchObject({
    earliest: iso(at(2, 0, 16)),
    why: "3 failures today: no more tries until tomorrow",
  });
  expect(nextNight(at(5), day, st("ok")).earliest).toBe(iso(at(2, 0, 16)));
  expect(nextMidday(at(10), undefined).earliest).toBe(iso(at(13)));
  expect(nextMidday(at(13, 10), undefined).earliest).toBe(iso(at(13, 10)));
  expect(nextMidday(at(14), iso(at(13, 5))).earliest).toBe(iso(at(19)));
  expect(nextMidday(at(20), iso(at(19, 5))).earliest).toBe(iso(at(13, 0, 16)));
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

test("a backfill reads a week at a time up to its last day, four a day; three failures of a week stop it", () => {
  const today = "2026-10-21";
  const b = { failures: 0, next: "2025-07-01", to: "2025-07-10" };
  const week = backfillWeek(b, today);
  expect(week).toEqual({ from: "2025-07-01", to: "2025-07-07" });
  // Read: the range moves on and the day counts it.
  const after = afterWeek(b, week as never, true, today);
  expect(after).toEqual({
    day: today,
    failures: 0,
    next: "2025-07-08",
    to: "2025-07-10",
    weeks: 1,
  });
  expect(backfillWeek(after, today)).toEqual({
    from: "2025-07-08",
    to: "2025-07-10",
  });
  // Failed: the same week again, one failure more; three stop it.
  expect(afterWeek(b, week as never, false, today)).toMatchObject({
    failures: 1,
    next: "2025-07-01",
  });
  expect(backfillWeek({ ...b, failures: 3 }, today)).toBeNull();
  // Four weeks a day, then the next day.
  const full = { ...after, weeks: 4 };
  expect(backfillWeek(full, today)).toBeNull();
  expect(backfillWeek(full, "2026-10-22")).not.toBeNull();
  expect(afterWeek(full, week as never, true, "2026-10-22").weeks).toBe(1);
  expect(backfillWeek({ ...b, next: "2025-07-11" }, today)).toBeNull();
  expect(backfillWeek(undefined, today)).toBeNull();
});
