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
  const steps = {
    endAt,
    id: "steps:1767261600000",
    kind: "steps",
    startAt,
    value: 42,
  };
  const weight = {
    endAt,
    id: "weight-one",
    kind: "weight",
    startAt,
    value: 65,
  };
  const sleep = {
    endAt,
    id: "sleep-one",
    kind: "sleep",
    stage: "deep",
    startAt,
  };
  expect(await (await send([steps, weight, sleep])).json()).toEqual({
    stored: 3,
  });
  const seqOf = async (after: number) =>
    (await page(after, 1)).measurements[0].seq as number;
  const first = await seqOf(0);
  const second = await seqOf(first);
  const cursor = await seqOf(second);
  expect((await page()).measurements).toEqual([
    { ...steps, seq: first },
    { ...weight, seq: second },
    { ...sleep, seq: cursor },
  ]);
  expect([first, second, cursor]).toEqual(
    [first, second, cursor].toSorted((a, b) => a - b)
  );
  expect(
    await (
      await send([
        { ...steps, startAt: "2026-01-01T11:00:00+01:00", value: 42.0 },
        weight,
        sleep,
      ])
    ).json()
  ).toEqual({ stored: 0 });
  expect(await page(cursor)).toEqual({ measurements: [] });
  expect(await (await send([{ ...steps, value: 56 }])).json()).toEqual({
    stored: 1,
  });
  const changed = (await page(cursor)).measurements;
  expect(changed).toEqual([{ ...steps, seq: changed[0].seq, value: 56 }]);
  expect(changed[0].seq).toBeGreaterThan(cursor);
  expect((await page()).measurements.map((m: { id: string }) => m.id)).toEqual([
    weight.id,
    sleep.id,
    steps.id,
  ]);
  expect(countRows(env.db, changeLog)).toBe(0);
});

test("all six kinds round trip; invalid unions, bounds and oversized batches are refused", async () => {
  const measurements = [
    {
      activity: "strength_training",
      endAt,
      id: "workout-one",
      kcal: 123,
      kind: "workout",
      startAt,
    },
    { endAt, id: "heart-one", kind: "resting_heart_rate", startAt, value: 60 },
    {
      endAt,
      id: "hrv-one",
      kind: "heart_rate_variability",
      startAt,
      value: 35,
    },
  ];
  expect(await (await send(measurements)).json()).toEqual({ stored: 3 });
  const all = await page();
  for (const m of measurements) {
    expect(all.measurements).toContainEqual(expect.objectContaining(m));
  }
  const refused = await Promise.all(
    [
      { endAt, id: "bad", kind: "sleep", stage: "future", startAt },
      { endAt: startAt, id: "bad", kind: "steps", startAt: endAt, value: 1 },
      { endAt, id: "bad", kind: "weight", startAt },
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
