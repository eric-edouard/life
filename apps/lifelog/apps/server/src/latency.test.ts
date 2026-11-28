import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { heartbeats, sources } from "@lifelog/db/schema";
import { phoneNudger, storePushToken } from "./apns";
import { askForUploads } from "./latency";
import { setSwitches } from "./switches";
import { testDb } from "./testing";

let env: Awaited<ReturnType<typeof testDb>>;
beforeAll(() => {
  env = testDb();
});
afterAll(() => env.drop());
beforeEach(() => env.reset());

const T0 = Date.parse("2026-10-12T10:00:00Z");
const SOURCE = "pendant-1";

test("the phone is asked for its blocks while the Pendant records and heard-through lags 5 minutes", async () => {
  const asked: unknown[] = [];
  const nudge = (ready: string, fields?: unknown) => {
    asked.push({ ready, ...(fields as object) });
    return Promise.resolve();
  };
  const now = new Date(T0);
  let beats = 0;
  const heartbeat = (state: string, lastKnown?: string) => {
    beats += 1;
    return env.db
      .insert(heartbeats)
      .values({
        body: { recording: { lastKnown, state } },
        id: randomUUID(),
        // Each one later than the last: the latest is read by its time.
        observedAt: new Date(T0 + beats),
        reason: "periodic",
        receivedAt: new Date(),
      })
      .run();
  };
  // Before the handover there is no heard-through: nothing to ask.
  heartbeat("recording");
  expect(await askForUploads(env.db, nudge, now)).toBe(false);
  env.db
    .insert(sources)
    .values({
      heardThrough: new Date(T0 - 4 * 60_000),
      id: SOURCE,
    })
    .run();
  expect(await askForUploads(env.db, nudge, now)).toBe(false);
  env.db
    .update(sources)
    .set({ heardThrough: new Date(T0 - 6 * 60_000) })
    .run();
  expect(await askForUploads(env.db, nudge, now)).toBe(true);
  expect(asked).toEqual([{ behindSeconds: 360, ready: "upload" }]);
  // The link lost: the Pendant still records to its flash, by its last confirmed state.
  heartbeat("unknown", "recording");
  expect(await askForUploads(env.db, nudge, now)).toBe(true);
  // The last confirmed state wins over the current one.
  heartbeat("recording", "not_recording");
  expect(await askForUploads(env.db, nudge, now)).toBe(false);
  // The Pendant paused: the phone has nothing to send.
  heartbeat("paused", "not_recording");
  expect(await askForUploads(env.db, nudge, now)).toBe(false);
  expect(asked).toHaveLength(2);
});

test("the owner is asked to open the app once per episode, at his delay", async () => {
  const alerts: unknown[] = [];
  const nudge = phoneNudger(env.db, (_token, push) => {
    if (push.kind === "voice.waiting") {
      alerts.push(push);
    }
    return Promise.resolve({ body: "", status: 200 });
  });
  storePushToken(env.db, "ab".repeat(80));
  env.db
    .insert(heartbeats)
    .values({
      body: { recording: { state: "recording" } },
      id: randomUUID(),
      observedAt: new Date(),
      reason: "periodic",
      receivedAt: new Date(),
    })
    .run();
  // A tick `at` minutes in, with the Pendant heard through `heard` minutes in; returns the alerts so far.
  const tick = async (at: number, heard: number, delay = 15) => {
    setSwitches(env.db, { openAppAfterMinutes: delay });
    env.db
      .insert(sources)
      .values({ heardThrough: new Date(T0 + heard * 60_000), id: SOURCE })
      .onConflictDoUpdate({
        set: { heardThrough: new Date(T0 + heard * 60_000) },
        target: sources.id,
      })
      .run();
    await askForUploads(env.db, nudge, new Date(T0 + at * 60_000));
    return alerts.length;
  };
  expect(await tick(0, -14)).toBe(0);
  expect(await tick(0, -16)).toBe(1);
  expect(alerts[0]).toEqual({ kind: "voice.waiting" });
  // Still behind at the next ticks: the same episode.
  expect(await tick(5, -16)).toBe(1);
  expect(await tick(10, -16)).toBe(1);
  // Caught up, then behind again: a new episode.
  expect(await tick(30, 25)).toBe(1);
  expect(await tick(42, 25)).toBe(2);
  // Off: never.
  expect(await tick(200, 25, 0)).toBe(2);
  // Not recording: nothing.
  env.db
    .insert(heartbeats)
    .values({
      body: { recording: { state: "paused" } },
      id: randomUUID(),
      observedAt: new Date(),
      reason: "periodic",
      receivedAt: new Date(),
    })
    .run();
  expect(await tick(400, 25)).toBe(2);
  setSwitches(env.db, { openAppAfterMinutes: 15 });
});
