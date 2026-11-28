import { expect, test } from "bun:test";
import type { Push } from "@life/server/src/core/push";
import {
  APP_TOPIC,
  apnsRequestOf,
  type PushRequest,
  type PushResponse,
} from "./apns-request";
import { pushRelayOf } from "./push-relay";

const PUSH_ID = "9f2c41d07ab35e68";
const TOKEN = "ab".repeat(80);
const IP = "203.0.113.7";

interface Sent {
  path: string;
  request: Omit<PushRequest, "path">;
}

/** A relay whose signer keeps what it was asked to send, and answers as APNs would. */
const relayOf = (
  answer: PushResponse = { apnsId: "apns-1", body: "", status: 200 }
) => {
  const sent: Sent[] = [];
  const fetch = pushRelayOf({}, (path, request) => {
    sent.push({ path, request });
    return Promise.resolve(answer);
  });
  return { fetch, sent };
};

const pushTo =
  (fetch: (request: Request) => Promise<Response>) =>
  (body: unknown, { ip = IP }: { ip?: string } = {}) =>
    fetch(
      new Request("https://life-push.fly.dev/push", {
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "fly-client-ip": ip },
        method: "POST",
      })
    );

test("health is a 200, and nothing else is served", async () => {
  const { fetch } = relayOf();
  const url = new URL("https://life-push.fly.dev/health");
  expect((await fetch(new Request(url))).status).toBe(200);
  for (const [path, method] of [
    ["/push", "GET"],
    ["/health", "POST"],
    ["/", "POST"],
    ["/push/", "POST"],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one request at a time, as a caller makes them
    const answer = await fetch(
      new Request(new URL(`https://life-push.fly.dev${path}`), { method })
    );
    expect(answer.status).toBe(404);
  }
});

test("ids only: any word, a badge, an unknown kind or a bad body is refused", async () => {
  const { fetch, sent } = relayOf();
  const push = pushTo(fetch);
  const card = { kind: "card.new", pushId: PUSH_ID, token: TOKEN };
  const refused = await Promise.all(
    [
      {
        push: { body: "It reached its agent.", title: "Orbit heard you" },
        token: TOKEN,
      },
      { push: { badge: 1, kind: "card.new", pushId: PUSH_ID }, token: TOKEN },
      {
        push: { kind: "card.new", level: "critical", pushId: PUSH_ID },
        token: TOKEN,
      },
      { push: { kind: "card.added", pushId: PUSH_ID }, token: TOKEN },
      { push: { kind: "card.new", pushId: "Kit's card" }, token: TOKEN },
      { push: { kind: "cards.removed", removed: [] }, token: TOKEN },
      { push: { kind: "voice.ready" }, token: "not hex" },
      { push: { kind: "voice.ready" }, token: `f${TOKEN}f`.repeat(2) },
      { ...card, extra: 1 },
      { push: { kind: "voice.ready" } },
      ["not", "an", "object"],
      "not json at all",
    ].map(async (bad) => (await push(bad)).status)
  );
  expect(refused).toEqual([
    400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400,
  ]);
  expect(sent).toHaveLength(0);
  // A push is small: past 4 KB it is turned away unread.
  expect((await push("x".repeat(5000))).status).toBe(413);
});

test("a request Fly did not stamp with a caller's address is refused, nothing sent", async () => {
  const { fetch, sent } = relayOf();
  const answers = await Promise.all(
    ([{}, { "fly-client-ip": "" }] as Record<string, string>[]).map((headers) =>
      fetch(
        new Request("https://life-push.fly.dev/push", {
          body: JSON.stringify({ push: { kind: "voice.ready" }, token: TOKEN }),
          headers,
          method: "POST",
        })
      )
    )
  );
  expect(answers.map((answer) => answer.status)).toEqual([400, 400]);
  expect(sent).toHaveLength(0);
});

test("each kind goes to APNs as the one composer says, on the phone's path, its answer taken as APNs'", async () => {
  const pushes: Push[] = [
    { kind: "card.new", level: "time-sensitive", pushId: PUSH_ID },
    { kind: "calendar.added", level: "passive", pushId: PUSH_ID },
    { kind: "thread.heard", pushId: PUSH_ID },
    { kind: "thread.answered", pushId: PUSH_ID },
    { kind: "thread.failed", pushId: PUSH_ID },
    { kind: "voice.waiting" },
    { kind: "cards.removed", removed: [PUSH_ID] },
    { kind: "voice.ready" },
  ];
  for (const push of pushes) {
    const { fetch, sent } = relayOf();
    // biome-ignore lint/performance/noAwaitInLoops: one kind at a time, each on its own relay
    const answer = await pushTo(fetch)({ push, token: TOKEN });
    expect(sent).toEqual([
      {
        path: `/3/device/${TOKEN}`,
        request: apnsRequestOf(push, APP_TOPIC),
      },
    ]);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("apns-id")).toBe("apns-1");
  }
  // APNs' refusal comes back as it is, body and all.
  const { fetch } = relayOf({
    body: JSON.stringify({ reason: "BadDeviceToken" }),
    status: 410,
  });
  const answer = await pushTo(fetch)({
    push: { kind: "voice.ready" },
    token: TOKEN,
  });
  expect(answer.status).toBe(410);
  expect(await answer.json()).toEqual({ reason: "BadDeviceToken" });
});

test("a phone is held to 300 pushes an hour, and a caller to 3000", async () => {
  const { fetch, sent } = relayOf();
  const push = pushTo(fetch);
  const tokenOf = (n: number) => n.toString(16).padStart(64, "0");
  const once = { kind: "voice.ready" };
  const token = tokenOf(1);
  for (let n = 0; n < 300; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: a counted hour, one push after another
    expect((await push({ push: once, token })).status).toBe(200);
  }
  expect((await push({ push: once, token })).status).toBe(429);
  // Another phone from the same caller is not the first one's fault.
  expect((await push({ push: once, token: tokenOf(2) })).status).toBe(200);
  expect(sent).toHaveLength(301);
  // A caller's own hour: 3000 phones over one IP, the next refused, another IP free.
  const many = relayOf();
  const fromIp = pushTo(many.fetch);
  for (let n = 1; n <= 3000; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: a counted hour, one push after another
    expect((await fromIp({ push: once, token: tokenOf(n) })).status).toBe(200);
  }
  expect((await fromIp({ push: once, token: tokenOf(4000) })).status).toBe(429);
  expect(
    (await fromIp({ push: once, token: tokenOf(4001) }, { ip: "198.51.100.9" }))
      .status
  ).toBe(200);
});
