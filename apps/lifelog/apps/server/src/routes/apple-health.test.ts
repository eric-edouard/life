import { afterAll, beforeAll, expect, test } from "bun:test";
import { countRows } from "@lifelog/db";
import { changeLog } from "@lifelog/db/schema";
import { createApp } from "../app";
import { memoryAudioStore } from "../audio-store";
import { sha256Hex } from "../config";
import { services } from "../services";
import { OWNER_TOKEN, testConfig, testDb } from "../testing";

const env = testDb();
const config = {
  ...testConfig("http://localhost:1"),
  READ_TOKEN_HASH: sha256Hex("reader-test"),
};
const app = createApp(
  services(config, env.db, {
    audio: memoryAudioStore(),
    intelligence: null,
    search: null,
  })
);
beforeAll(() => env.reset());
afterAll(() => env.drop());
const startAt = "2026-01-01T10:00:00.000Z";
const endAt = "2026-01-01T11:00:00.000Z";
const send = (measurements: unknown[]) =>
  app.request("/apple-health", {
    body: JSON.stringify({ measurements }),
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
const page = async (after = 0, limit = 1000) => {
  const res = await app.request(`/apple-health?after=${after}&limit=${limit}`, {
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return res.json();
};

test("identical values keep their cursor; changed rows move after it; pages follow seq", async () => {
  const workout = {
    activity: "running",
    endAt,
    id: "run-one",
    kcal: 42,
    kind: "workout",
    startAt,
  };
  const walk = {
    activity: "walking",
    endAt,
    id: "walk-one",
    kind: "workout",
    startAt,
  };
  const sleep = {
    endAt,
    id: "sleep-one",
    kind: "sleep",
    stage: "deep",
    startAt,
  };
  expect(await (await send([workout, walk, sleep])).json()).toEqual({
    stored: 3,
  });
  const seqOf = async (after: number) =>
    (await page(after, 1)).measurements[0].seq as number;
  const first = await seqOf(0);
  const second = await seqOf(first);
  const cursor = await seqOf(second);
  expect((await page()).measurements).toEqual([
    { ...workout, seq: first },
    { ...walk, seq: second },
    { ...sleep, seq: cursor },
  ]);
  expect([first, second, cursor]).toEqual(
    [first, second, cursor].toSorted((a, b) => a - b)
  );
  expect(
    await (
      await send([
        { ...workout, kcal: 42.0, startAt: "2026-01-01T11:00:00+01:00" },
        walk,
        sleep,
      ])
    ).json()
  ).toEqual({ stored: 0 });
  expect(await page(cursor)).toEqual({ measurements: [] });
  expect(await (await send([{ ...workout, kcal: 56 }])).json()).toEqual({
    stored: 1,
  });
  const changed = (await page(cursor)).measurements;
  expect(changed).toEqual([{ ...workout, kcal: 56, seq: changed[0].seq }]);
  expect(changed[0].seq).toBeGreaterThan(cursor);
  expect((await page()).measurements.map((m: { id: string }) => m.id)).toEqual([
    walk.id,
    sleep.id,
    workout.id,
  ]);
  expect(countRows(env.db, changeLog)).toBe(0);
});

test("only sleep and workouts round trip; invalid unions, bounds and oversized batches are refused", async () => {
  const measurements = [
    {
      activity: "strength_training",
      endAt,
      id: "workout-one",
      kcal: 123,
      kind: "workout",
      startAt,
    },
    { endAt, id: "sleep-two", kind: "sleep", stage: "rem", startAt },
  ];
  expect(await (await send(measurements)).json()).toEqual({ stored: 2 });
  const all = await page();
  for (const m of measurements) {
    expect(all.measurements).toContainEqual(expect.objectContaining(m));
  }
  const refused = await Promise.all(
    [
      { endAt, id: "bad", kind: "sleep", stage: "future", startAt },
      { ...measurements[0], endAt: startAt, startAt: endAt },
      { endAt, id: "bad", kind: "workout", startAt },
      ...[
        "steps",
        "weight",
        "resting_heart_rate",
        "heart_rate_variability",
      ].map((kind) => ({ endAt, id: "bad", kind, startAt, value: 1 })),
    ].map((bad) => send([bad]))
  );
  for (const res of refused) {
    expect(res.status).toBe(400);
  }
  expect((await send(new Array(1001).fill(measurements[0]))).status).toBe(400);
});

test("reader tokens cannot read or upload Apple Health", async () => {
  const refused = await Promise.all(
    ["GET", "POST"].map((method) =>
      app.request("/apple-health", {
        headers: { Authorization: "Bearer reader-test" },
        method,
      })
    )
  );
  for (const res of refused) {
    expect(res.status).toBe(403);
  }
});
