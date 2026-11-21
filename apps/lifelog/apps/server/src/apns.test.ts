import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  apnsFor,
  latestPushToken,
  type PushRequest,
  phoneNudger,
  storePushToken,
} from "./apns";
import { createApp } from "./app";
import { sha256Hex } from "./config";
import { services } from "./services";
import { OWNER_TOKEN, testConfig, testDb } from "./testing";

const MAC_TOKEN = "mac-test-token";
const PUSH_TOKEN = "ab".repeat(80);
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

let env: Awaited<ReturnType<typeof testDb>>;
let sent: { origin: string; request: PushRequest }[] = [];

const config = testConfig("http://localhost:1", {
  APNS_KEY_ID: "KEY1234567",
  APNS_PRIVATE_KEY: privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string,
  APNS_TEAM_ID: "TEAM123456",
  MAC_TOKEN_HASH: sha256Hex(MAC_TOKEN),
});
const appWith = (apns: ReturnType<typeof apnsFor>) =>
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
});

const pusher = () =>
  apnsFor(config, (origin, request) => {
    sent.push({ origin, request });
    return Promise.resolve({ body: "", status: 200 });
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

test("the provider token is an ES256 JWT Apple can verify", async () => {
  storePushToken(env.db, PUSH_TOKEN);
  await phoneNudger(env.db, pusher(), "com.example.app")("summary");
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
  const push = apnsFor(config, (origin, request) => {
    sent.push({ origin, request });
    return Promise.resolve({
      apnsId: "apns-1",
      body: JSON.stringify({ reason: "BadDeviceToken" }),
      status: 400,
    });
  });
  const app = appWith(push);
  expect((await putToken(app, PUSH_TOKEN)).status).toBe(200);
  await phoneNudger(env.db, push, "com.example.app")("transcript");
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
    reason: "BadDeviceToken",
    status: 400,
    token: "abababab",
  });
  expect(seen.map((e) => e.name)).toContain("apns.token_dropped");
});

test("only the device token stores a push token, and only hex", async () => {
  const app = appWith(null);
  expect((await putToken(app, "not hex")).status).toBe(400);
  expect((await putToken(app, PUSH_TOKEN, MAC_TOKEN)).status).toBe(401);
});

test("an event with content-sized fields is refused", async () => {
  const res = await appWith(null).request("/events", {
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
  const nudge = phoneNudger(env.db, pusher(), "com.example.app");
  await nudge("transcript");
  expect(sent).toHaveLength(0);
  storePushToken(env.db, PUSH_TOKEN);
  await nudge("transcript", { job: "j1" });
  const [push] = sent;
  expect(push?.request.path).toBe(`/3/device/${PUSH_TOKEN}`);
  expect(push?.request.headers).toMatchObject({
    "apns-priority": "5",
    "apns-push-type": "background",
    "apns-topic": "com.example.app",
  });
  expect(JSON.parse(push?.request.body ?? "")).toEqual({
    aps: { "content-available": 1 },
    lifelog: "processing",
  });
});

test("a notice another app asks for is one visible push; an empty or long title is refused", async () => {
  storePushToken(env.db, PUSH_TOKEN);
  const app = appWith(pusher());
  const post = (body: unknown) =>
    app.request("/notifications", {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${OWNER_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  expect(
    (await post({ body: "It reached its agent.", title: "Orbit heard you" }))
      .status
  ).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.request.headers).toMatchObject({
    "apns-priority": "10",
    "apns-push-type": "alert",
  });
  expect(JSON.parse(sent[0]?.request.body ?? "")).toEqual({
    aps: {
      alert: { body: "It reached its agent.", title: "Orbit heard you" },
      sound: "default",
    },
  });
  expect((await post({ body: "x", title: "" })).status).toBe(400);
  expect((await post({ body: "x", title: "t".repeat(101) })).status).toBe(400);
  expect(sent).toHaveLength(1);
});

test("Life's card pushes: one card names its id and can be rewritten, a badge alone is silent", async () => {
  storePushToken(env.db, PUSH_TOKEN);
  const app = appWith(pusher());
  const post = (body: unknown) =>
    app.request("/notifications", {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${OWNER_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  const last = () => JSON.parse(sent.at(-1)?.request.body ?? "");
  const pushId = "9f2c41d07ab35e68";
  expect(
    (
      await post({
        badge: 42,
        body: "1 new card",
        level: "time-sensitive",
        pushId,
        title: "Life",
      })
    ).status
  ).toBe(200);
  expect(last()).toEqual({
    aps: {
      alert: { body: "1 new card", title: "Life" },
      badge: 42,
      category: "life.card",
      "interruption-level": "time-sensitive",
      "mutable-content": 1,
      sound: "default",
      "thread-id": "life-cards",
    },
    pushId,
  });
  expect(sent.at(-1)?.request.headers["apns-collapse-id"]).toBe(pushId);
  await post({ badge: 41 });
  expect(last()).toEqual({
    aps: {
      badge: 41,
      "thread-id": "life-cards",
    },
  });
  expect(sent.at(-1)?.request.headers["apns-collapse-id"]).toBeUndefined();
  await post({
    badge: 41,
    body: "3 more new cards",
    level: "passive",
    title: "Life",
  });
  expect(last()).toEqual({
    aps: {
      alert: { body: "3 more new cards", title: "Life" },
      badge: 41,
      "interruption-level": "passive",
      "thread-id": "life-cards",
    },
  });
  expect(sent).toHaveLength(3);
  // An appointment Life added: its own category, no badge, its kind beside `aps`.
  await post({
    body: "Added to your calendar",
    kind: "calendar.added",
    level: "passive",
    pushId,
    title: "Life",
  });
  expect(last()).toEqual({
    aps: {
      alert: { body: "Added to your calendar", title: "Life" },
      category: "life.calendar",
      "interruption-level": "passive",
      "mutable-content": 1,
    },
    kind: "calendar.added",
    pushId,
  });
  const refused = await Promise.all(
    [
      { title: "Life" },
      { body: "x" },
      { badge: -1 },
      { badge: 1, pushId: "Kit's card" },
      { badge: 1, level: "critical" },
      { badge: 1, kind: "card.added" },
      { badge: 0, kind: "calendar.added" },
      { body: "x", kind: "calendar.added", title: "Life" },
    ].map(async (bad) => (await post(bad)).status)
  );
  expect(refused).toEqual([400, 400, 400, 400, 400, 400, 400, 400]);
  expect(sent).toHaveLength(4);
  // Cards that left his inbox: alone, a background push the phone removes their notifications on.
  expect((await post({ removed: [pushId] })).status).toBe(200);
  expect(last()).toEqual({
    aps: { "content-available": 1 },
    removed: [pushId],
  });
  expect(sent.at(-1)?.request.headers).toMatchObject({
    "apns-priority": "5",
    "apns-push-type": "background",
  });
  const mixed = await Promise.all(
    [
      { badge: 1, removed: [pushId] },
      { removed: [] },
      { removed: ["Kit's card"] },
    ].map(async (bad) => (await post(bad)).status)
  );
  expect(mixed).toEqual([400, 400, 400]);
  expect(sent).toHaveLength(5);
});
