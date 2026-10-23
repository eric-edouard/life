import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { subscriptionUsage } from "@life/voice-db/schema";
import {
  SubscriptionMessage,
  storeSubscriptionUsage,
  subscriptions,
} from "./subscriptions";
import { testDb } from "./testing";

let env: Awaited<ReturnType<typeof testDb>>;
beforeAll(() => {
  env = testDb();
});
beforeEach(() => {
  env.reset();
});
afterAll(() => {
  env.drop();
});

const reading = {
  fiveHour: { resetsAt: 1_800_010_000, usedPercent: 0 },
  observedAt: 1_750_000_000,
  sevenDay: { resetsAt: 1_800_600_000, usedPercent: 100 },
};

test("usage is unknown until the Mac observes it, and a newer observation replaces the last", () => {
  expect(subscriptions(env.db)).toEqual({ claude: null, codex: null });
  storeSubscriptionUsage(env.db, {
    engine: "claude",
    reading,
    type: "subscription.usage",
  });
  const newer = {
    ...reading,
    fiveHour: null,
    observedAt: reading.observedAt + 300,
  };
  storeSubscriptionUsage(env.db, {
    engine: "claude",
    reading: newer,
    type: "subscription.usage",
  });
  expect(subscriptions(env.db)).toEqual({ claude: newer, codex: null });
});

test("a stored reading that no longer parses is unknown, and the feed still answers", () => {
  env.db
    .insert(subscriptionUsage)
    .values({ engine: "codex", reading: { observedAt: "yesterday" } })
    .run();
  expect(subscriptions(env.db)).toEqual({ claude: null, codex: null });
});

test("observations survive disconnects and replay cannot move their clock backwards", () => {
  storeSubscriptionUsage(env.db, {
    engine: "claude",
    reading,
    type: "subscription.usage",
  });
  storeSubscriptionUsage(env.db, {
    engine: "claude",
    reading: { ...reading, observedAt: reading.observedAt - 1, sevenDay: null },
    type: "subscription.usage",
  });
  storeSubscriptionUsage(env.db, {
    engine: "codex",
    reading: { ...reading, observedAt: Date.now() / 1000 + 3600 },
    type: "subscription.usage",
  });
  expect(subscriptions(env.db)).toEqual({ claude: reading, codex: null });
});

test("a window the Mac didn't send is unknown; invalid and token-based reports are rejected", () => {
  const { fiveHour, ...weekOnly } = reading;
  expect(
    SubscriptionMessage.parse({
      engine: "claude",
      reading: weekOnly,
      type: "subscription.usage",
    }).reading.fiveHour
  ).toBeNull();
  for (const bad of [
    { ...reading, fiveHour: { resetsAt: 0, usedPercent: 101 } },
    { ...reading, observedAt: Number.POSITIVE_INFINITY },
    { inputTokens: 3000, outputTokens: 500 },
  ]) {
    expect(
      SubscriptionMessage.safeParse({
        engine: "claude",
        reading: bad,
        type: "subscription.usage",
      }).success
    ).toBe(false);
  }
});
