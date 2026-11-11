import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR, MIN } from "../core/clock";
import { setSettings, settings } from "../core/settings";
import { SourceEvent } from "../records/source";
import {
  earliestAppleHealth,
  type Measurement,
  newestAppleHealth,
  nightsOf,
  readAppleHealth,
  syncAppleHealth,
} from "./apple-health";

const sleep = (
  id: string,
  startAt: string,
  endAt: string,
  stage: Extract<Measurement, { kind: "sleep" }>["stage"] = "asleep"
) => ({ endAt, id, kind: "sleep" as const, stage, startAt });

test("sleep unions overlapping devices, keeps stages and awake time, and separates a nap at an hour's gap", () => {
  const segments = [
    sleep("bed", "2024-02-01T19:00:00Z", "2024-02-02T04:00:00Z", "in_bed"),
    sleep("watch", "2024-02-01T20:00:00Z", "2024-02-02T03:00:00Z"),
    sleep("deep", "2024-02-01T20:30:00Z", "2024-02-01T21:30:00Z", "deep"),
    sleep("rem", "2024-02-01T22:00:00Z", "2024-02-01T22:30:00Z", "rem"),
    sleep("awake", "2024-02-01T23:00:00Z", "2024-02-01T23:25:00Z", "awake"),
    sleep("phone", "2024-02-01T21:00:00Z", "2024-02-02T03:05:00Z", "core"),
    sleep("nap", "2024-02-02T05:00:00Z", "2024-02-02T05:25:00Z"),
  ];
  const events = nightsOf(segments.toReversed());
  expect(events.map((e) => e.text)).toEqual([
    "fell asleep",
    "woke: 7 h 5 min asleep (deep 1 h, REM 30 min, core 6 h 5 min), awake 25 min",
    "fell asleep",
    "woke: 25 min asleep",
  ]);
  expect(events[1]?.measured).toEqual({
    asleepMs: 7 * HOUR + 5 * MIN,
    kind: "sleep",
  });
  expect(events.every((e) => SourceEvent.safeParse(e).success)).toBe(true);
  expect(
    nightsOf(
      segments.filter((s) => s.stage === "in_bed" || s.stage === "awake")
    )
  ).toEqual([]);
});

test("sync pages after its copied cursor, replaces a changed id and rebuilds a lost copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-apple-health-"));
  const old = settings().lifelog;
  const token = process.env.LIFELOG_TOKEN;
  setSettings({ lifelog: { url: "https://lifelog.example" } });
  process.env.LIFELOG_TOKEN = "made-up-device-token";
  const base = {
    endAt: "2024-02-02T08:00:00.000Z",
    id: "hour",
    kind: "steps",
    startAt: "2024-02-02T07:00:00.000Z",
  };
  let changed = false;
  let fail = false;
  let hasDay = false;
  let hasBadCursor = false;
  const cursors: number[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(((
    input: string | URL | Request
  ) => {
    const after = Number(new URL(String(input)).searchParams.get("after"));
    cursors.push(after);
    if (fail) {
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    }
    if (hasBadCursor) {
      return Promise.resolve(
        Response.json({ measurements: [{ ...base, seq: after, value: 99 }] })
      );
    }
    if (hasDay && after < 8) {
      return Promise.resolve(
        Response.json({
          measurements: [
            {
              ...sleep("night", "2026-10-09T21:30:00Z", "2026-10-09T22:40:00Z"),
              seq: 4,
            },
            {
              activity: "running",
              endAt: "2026-10-10T06:42:00Z",
              id: "run",
              kcal: 315.4,
              kind: "workout",
              seq: 5,
              startAt: "2026-10-10T06:00:00Z",
            },
            {
              endAt: "2026-10-10T07:00:00Z",
              id: "weight",
              kind: "weight",
              seq: 6,
              startAt: "2026-10-10T07:00:00Z",
              value: 68.24,
            },
            {
              endAt: "2026-10-10T08:00:00Z",
              id: "resting",
              kind: "resting_heart_rate",
              seq: 7,
              startAt: "2026-10-10T08:00:00Z",
              value: 57,
            },
            {
              endAt: "2026-10-10T09:00:00Z",
              id: "hrv",
              kind: "heart_rate_variability",
              seq: 8,
              startAt: "2026-10-10T09:00:00Z",
              value: 41.3,
            },
          ],
        })
      );
    }
    const seq = changed ? 3 : 1;
    return Promise.resolve(
      Response.json(
        after < seq
          ? { measurements: [{ ...base, seq, value: changed ? 280 : 140 }] }
          : { measurements: [] }
      )
    );
  }) as typeof globalThis.fetch);
  try {
    expect(earliestAppleHealth(dir)).toBeNull();
    expect(newestAppleHealth(dir)).toEqual({ at: null });
    expect(readAppleHealth(new Date(0), undefined, dir)).toEqual([]);
    await syncAppleHealth(dir);
    changed = true;
    await syncAppleHealth(dir);
    expect(cursors).toEqual([0, 1, 1, 3]);
    const read = () => readAppleHealth(new Date(0), undefined, dir);
    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject({
      measured: { kind: "steps", value: 280 },
      text: "280 steps",
    });
    expect(earliestAppleHealth(dir)).toBe(base.startAt);
    expect(newestAppleHealth(dir)).toEqual({ at: base.startAt });
    expect(readAppleHealth(new Date(0), new Date(base.startAt), dir)).toEqual(
      []
    );
    fail = true;
    await expect(syncAppleHealth(dir)).rejects.toThrow("503");
    expect(read()).toHaveLength(1);
    fail = false;
    await syncAppleHealth(dir);
    expect(cursors.at(-1)).toBe(3);
    rmSync(dir, { recursive: true });
    await syncAppleHealth(dir);
    expect(cursors.slice(-2)).toEqual([0, 3]);
    expect(read()).toHaveLength(1);
    hasDay = true;
    await syncAppleHealth(dir);
    const wakeDay = readAppleHealth(
      new Date("2026-10-09T22:00:00Z"),
      new Date("2026-10-10T22:00:00Z"),
      dir
    );
    expect(wakeDay.map((e) => e.measured?.kind)).toEqual([
      "sleep",
      "workout",
      "weight",
      "resting_heart_rate",
      "heart_rate_variability",
    ]);
    expect(wakeDay.every((e) => SourceEvent.safeParse(e).success)).toBe(true);
    expect(wakeDay.map((e) => e.text)).toEqual([
      "woke: 1 h 10 min asleep",
      "running, 315 kcal",
      "weight 68.2 kg",
      "resting heart rate 57 bpm",
      "HRV 41 ms",
    ]);
    hasBadCursor = true;
    await expect(syncAppleHealth(dir)).rejects.toThrow("cursor");
    hasBadCursor = false;
    await syncAppleHealth(dir);
    expect(cursors.at(-1)).toBe(8);
  } finally {
    fetch.mockRestore();
    setSettings({ lifelog: old });
    if (token === undefined) {
      delete process.env.LIFELOG_TOKEN;
    } else {
      process.env.LIFELOG_TOKEN = token;
    }
    rmSync(dir, { force: true, recursive: true });
  }
});
