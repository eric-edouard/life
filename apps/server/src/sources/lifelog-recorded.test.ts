import { expect, test } from "bun:test";
import { DAY, iso } from "../core/clock";
import { readRecorded } from "./lifelog-recorded";

const to = Date.parse("2026-11-12T00:00:00.000Z");
const stretch = (startAt: number) => ({
  endAt: iso(startAt + 1000),
  startAt: iso(startAt),
});

/** A lifelog that can tell since `since`, with one stretch at the start of each page asked; and what it was asked. */
function lifelog(since: string | null) {
  const asked: [string, string][] = [];
  const ask = (from: string, until: string) => {
    asked.push([from, until]);
    return Promise.resolve({
      since,
      stretches: [stretch(Date.parse(from))],
    });
  };
  return { ask, asked };
}

test("lifelog is asked 31 days at a time, newest first, down to the page it can tell from; the stretches come back oldest first", async () => {
  const since = iso(to - 70 * DAY);
  const { ask, asked } = lifelog(since);
  const got = await readRecorded(iso(to), ask);
  expect(asked).toEqual([
    [iso(to - 31 * DAY), iso(to)],
    [iso(to - 62 * DAY), iso(to - 31 * DAY)],
    [iso(to - 93 * DAY), iso(to - 62 * DAY)],
  ]);
  expect(got.since).toBe(since);
  expect(got.stretches.map((s) => s.startAt)).toEqual([
    iso(to - 93 * DAY),
    iso(to - 62 * DAY),
    iso(to - 31 * DAY),
  ]);
});

test("a lifelog that holds no recording is asked one page; one that does not answer throws", async () => {
  const none = lifelog(null);
  expect(await readRecorded(iso(to), none.ask)).toEqual({
    since: null,
    stretches: [stretch(to - 31 * DAY)],
  });
  expect(none.asked).toHaveLength(1);
  const down = () => Promise.reject(new Error("down"));
  await expect(readRecorded(iso(to), down)).rejects.toThrow("down");
});
