import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Push } from "@life/server/src/core/push";
import {
  latestPushToken,
  PUSH_RELAY,
  type Pusher,
  phoneNudger,
  pusherFor,
  storePushToken,
} from "./apns";
import { apnsRequestOf, type PushRequest } from "./apns-request";
import { createApp } from "./app";
import { sha256Hex } from "./config";
import { services } from "./services";
import { OWNER_TOKEN, testConfig, testDb } from "./testing";

const MAC_TOKEN = "mac-test-token";
const PUSH_TOKEN = "ab".repeat(80);
const TOPIC = "com.example.app";
const PUSH_ID = "9f2c41d07ab35e68";
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

let env: Awaited<ReturnType<typeof testDb>>;
let sent: { origin: string; request: PushRequest }[] = [];
let posted: { origin: string; request: unknown }[] = [];

const config = testConfig("http://localhost:1", {
  APNS_KEY_ID: "KEY1234567",
  APNS_PRIVATE_KEY: privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string,
  APNS_TEAM_ID: "TEAM123456",
  APNS_TOPIC: TOPIC,
  MAC_TOKEN_HASH: sha256Hex(MAC_TOKEN),
});
// The direct path, its request kept instead of sent.
const pusher = (status = 200, body = "") =>
  pusherFor(config, (origin, request) => {
    sent.push({ origin, request });
    return Promise.resolve({ apnsId: "apns-1", body, status });
  });
const appWith = (apns: Pusher) =>
  createApp(
    services(config, env.db, {
      apns,
      intelligence: null,
      search: null,
    })
  );

beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
  sent = [];
  posted = [];
});

const putToken = (
  app: ReturnType<typeof createApp>,
  token: string,
  bearer = OWNER_TOKEN
) =>
  app.request("/notifications/push-token", {
    body: JSON.stringify({ token }),
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    method: "PUT",
  });

const post = (app: ReturnType<typeof createApp>, push: unknown) =>
  app.request("/notifications", {
    body: JSON.stringify(push),
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

const sentBody = (index = -1) => JSON.parse(sent.at(index)?.request.body ?? "");

test("the provider token is an ES256 JWT Apple can verify", async () => {
  storePushToken(env.db, PUSH_TOKEN);
  await phoneNudger(env.db, pusher())("summary");
  expect(sent[0]?.origin).toBe("https://api.sandbox.push.apple.com");
  const auth = sent[0]?.request.headers.authorization ?? "";
  const [header, claims, signature] = auth.replace("bearer ", "").split(".");
  const decode = (part = "") =>
    JSON.parse(Buffer.from(part, "base64url").toString());
  expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY1234567" });
  expect(decode(claims).iss).toBe("TEAM123456");
  expect(Math.abs(decode(claims).iat - Date.now() / 1000)).toBeLessThanOrEqual(
    2
  );
  // WebCrypto checks the raw r‖s signature the way APNs does.
  const key = await crypto.subtle.importKey(
    "jwk",
    publicKey.export({ format: "jwk" }),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    { hash: "SHA-256", name: "ECDSA" },
    key,
    Buffer.from(signature ?? "", "base64url"),
    Buffer.from(`${header}.${claims}`)
  );
  expect(valid).toBe(true);
});

test("a token APNs calls dead is dropped, so pushes wait for the phone's next one", async () => {
  const push = pusher(410, JSON.stringify({ reason: "Unregistered" }));
  const app = appWith(push);
  expect((await putToken(app, PUSH_TOKEN)).status).toBe(200);
  await phoneNudger(env.db, push)("transcript");
  expect(sent).toHaveLength(1);
  expect(latestPushToken(env.db)).toBeNull();
  const res = await app.request(
    `/events?since=${new Date(Date.now() - 60_000).toISOString()}`,
    { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } }
  );
  const seen = (await res.json()) as { fields: object; name: string }[];
  expect(seen.find((e) => e.name === "apns.sent")?.fields).toMatchObject({
    apnsId: "apns-1",
    kind: "processing",
    reason: "Unregistered",
    status: 410,
    token: "abababab",
  });
  expect(seen.map((e) => e.name)).toContain("apns.token_dropped");
});

test("a relay's 429 or a failed answer never drops the phone's token", async () => {
  const push = pusher(429, JSON.stringify({ reason: "TooManyRequests" }));
  storePushToken(env.db, PUSH_TOKEN);
  await phoneNudger(env.db, push)("transcript");
  expect(latestPushToken(env.db)).toBe(PUSH_TOKEN);
  sent = [];
  await phoneNudger(env.db, pusher(500, ""))("transcript");
  expect(latestPushToken(env.db)).toBe(PUSH_TOKEN);
});

test("an install without the app's own key posts its pushes to the push relay", async () => {
  const relay = spyOn(globalThis, "fetch").mockImplementation(((
    url: string | URL | Request,
    init?: RequestInit
  ) => {
    posted.push({
      origin: String(url),
      request: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(
      Response.json(
        { reason: "BadDeviceToken" },
        { headers: { "apns-id": "relay-1" }, status: 410 }
      )
    );
  }) as unknown as typeof fetch);
  storePushToken(env.db, PUSH_TOKEN);
  const direct = pusherFor(testConfig("http://localhost:1"));
  expect(direct).toBeTypeOf("function");
  await phoneNudger(env.db, direct)("summary", { job: "j1" });
  expect(posted[0]?.origin).toBe(PUSH_RELAY);
  expect(posted[0]?.request).toEqual({
    push: { kind: "voice.ready" },
    token: PUSH_TOKEN,
  });
  // APNs' own answer comes back through the relay: a dead token is dropped.
  expect(latestPushToken(env.db)).toBeNull();
  relay.mockRestore();
});

test("only the device token stores a push token, and only hex", async () => {
  const app = appWith(pusher());
  expect((await putToken(app, "not hex")).status).toBe(400);
  expect((await putToken(app, PUSH_TOKEN, MAC_TOKEN)).status).toBe(401);
});

test("an event with content-sized fields is refused", async () => {
  const res = await appWith(pusher()).request("/events", {
    body: JSON.stringify({
      at: new Date().toISOString(),
      fields: { text: "x".repeat(201) },
      id: randomUUID(),
      name: "activity.started",
    }),
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  expect(res.status).toBe(400);
});

test("a ready transcript is a silent push to the app, which the phone recognizes", async () => {
  const nudge = phoneNudger(env.db, pusher());
  await nudge("transcript");
  expect(sent).toHaveLength(0);
  storePushToken(env.db, PUSH_TOKEN);
  await nudge("transcript", { job: "j1" });
  const [push] = sent;
  expect(push?.request.path).toBe(`/3/device/${PUSH_TOKEN}`);
  expect(push?.request.headers).toMatchObject({
    "apns-priority": "5",
    "apns-push-type": "background",
    "apns-topic": TOPIC,
  });
  expect(JSON.parse(push?.request.body ?? "")).toEqual({
    aps: { "content-available": 1 },
    lifelog: "processing",
  });
});

test("every kind's push: the words, the category, and no id or word of ours beside it", () => {
  const payload = (push: Push) => JSON.parse(apnsRequestOf(push, TOPIC).body);
  const headers = (push: Push) => apnsRequestOf(push, TOPIC).headers;
  // A card names its id, can be rewritten by the phone, and joins Life's thread.
  expect(
    payload({ kind: "card.new", level: "active", pushId: PUSH_ID })
  ).toEqual({
    aps: {
      alert: { body: "New card", title: "Life" },
      category: "life.card",
      "interruption-level": "active",
      "mutable-content": 1,
      sound: "default",
      "thread-id": "life-cards",
    },
    kind: "card.new",
    pushId: PUSH_ID,
  });
  expect(
    headers({ kind: "card.new", level: "time-sensitive", pushId: PUSH_ID })
  ).toEqual({
    "apns-collapse-id": PUSH_ID,
    "apns-priority": "10",
    "apns-push-type": "alert",
    "apns-topic": TOPIC,
  });
  // An appointment: its own category, and quiet when Life says so.
  expect(
    payload({ kind: "calendar.added", level: "passive", pushId: PUSH_ID })
  ).toEqual({
    aps: {
      alert: { body: "Added to your calendar", title: "Life" },
      category: "life.calendar",
      "interruption-level": "passive",
      "mutable-content": 1,
    },
    kind: "calendar.added",
    pushId: PUSH_ID,
  });
  // A spoken ask: heard, then answered or not, the same id replacing the one before.
  expect(payload({ kind: "thread.heard", pushId: PUSH_ID })).toEqual({
    aps: {
      alert: { body: "On it.", title: "Life heard you" },
      sound: "default",
    },
    kind: "thread.heard",
    pushId: PUSH_ID,
  });
  expect(payload({ kind: "thread.answered", pushId: PUSH_ID })).toEqual({
    aps: {
      alert: { body: "Open Life to read it.", title: "Life answered" },
      sound: "default",
    },
    kind: "thread.answered",
    pushId: PUSH_ID,
  });
  expect(payload({ kind: "thread.failed", pushId: PUSH_ID })).toEqual({
    aps: {
      alert: { body: "Open Life to read it.", title: "Life couldn't do it" },
      sound: "default",
    },
    kind: "thread.failed",
    pushId: PUSH_ID,
  });
  // An alert about nothing to name: no id, no kind for the phone to route on.
  expect(payload({ kind: "voice.waiting" })).toEqual({
    aps: {
      alert: {
        body: "Your Pendant has audio waiting to sync.",
        title: "Open lifelog",
      },
      sound: "default",
    },
  });
  expect(headers({ kind: "voice.waiting" })).toEqual({
    "apns-priority": "10",
    "apns-push-type": "alert",
    "apns-topic": TOPIC,
  });
  // Background: the ids of what left his inbox, or that what waits is ready.
  expect(payload({ kind: "cards.removed", removed: [PUSH_ID] })).toEqual({
    aps: { "content-available": 1 },
    removed: [PUSH_ID],
  });
  expect(payload({ kind: "voice.ready" })).toEqual({
    aps: { "content-available": 1 },
    lifelog: "processing",
  });
  for (const background of [
    { kind: "cards.removed", removed: [PUSH_ID] },
    { kind: "voice.ready" },
  ] as Push[]) {
    expect(headers(background)).toEqual({
      "apns-priority": "5",
      "apns-push-type": "background",
      "apns-topic": TOPIC,
    });
  }
});

test("the route takes a kind and its id, and refuses any word or a badge", async () => {
  storePushToken(env.db, PUSH_TOKEN);
  const app = appWith(pusher());
  const taken = await post(app, { kind: "card.new", pushId: PUSH_ID });
  expect(taken.status).toBe(200);
  expect(sentBody()).toMatchObject({ kind: "card.new", pushId: PUSH_ID });
  const refused = await Promise.all(
    [
      { body: "It reached its agent.", title: "Orbit heard you" },
      { badge: 1 },
      { kind: "card.new", pushId: PUSH_ID, title: "Life" },
      { kind: "card.new", pushId: "Kit's card" },
      { kind: "card.added", pushId: PUSH_ID },
      { kind: "voice.waiting", level: "active" },
      { kind: "cards.removed", removed: [] },
    ].map(async (bad) => (await post(app, bad)).status)
  );
  expect(refused).toEqual([400, 400, 400, 400, 400, 400, 400]);
  expect(sent).toHaveLength(1);
});
