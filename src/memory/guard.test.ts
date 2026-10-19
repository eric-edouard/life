import { expect, test } from "bun:test";
import {
  decide,
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
