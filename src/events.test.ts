import { expect, test } from "bun:test";
import {
  nextEvent,
  resumeAt,
  type State,
  Subscribe,
  settle,
  sign,
} from "./events";
import { action } from "./memory/fixtures";

test("signatures are Standard Webhooks', checked against its published vector", () => {
  expect(
    sign(
      "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      1_614_265_330,
      '{"test": 2432232314}'
    )
  ).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const subscribe = (url: string, secret = SECRET) =>
  Subscribe.safeParse({
    arguments: {},
    cursor: null,
    delivery: { mode: "webhook", secret, url },
    name: "ask",
  }).success;

test("only an https callback on OpenAI's hosts, with a whsec_ secret of 24 to 64 bytes, can subscribe", () => {
  expect(subscribe("https://chatgpt.com/mcp-events/cb_1")).toBe(true);
  expect(subscribe("https://hooks.openai.com/cb")).toBe(true);
  expect(subscribe("http://chatgpt.com/cb")).toBe(false);
  expect(subscribe("https://evilchatgpt.com/cb")).toBe(false);
  expect(subscribe("https://chatgpt.com.evil.io/cb")).toBe(false);
  expect(subscribe("https://127.0.0.1/cb")).toBe(false);
  expect(
    subscribe(
      "https://chatgpt.com/cb",
      `whsec_${Buffer.alloc(16).toString("base64")}`
    )
  ).toBe(false);
  expect(subscribe("https://chatgpt.com/cb", "not-a-secret")).toBe(false);
});

const line = (over: Parameters<typeof action>[0]) =>
  JSON.stringify(action(over));
const ask = (id: string) =>
  line({
    after: {
      confidence: "low",
      conversation: "c1",
      turns: [3, 4],
    },
    id,
    kind: "ask",
    madeBy: "watch",
    target: "atlas",
  });

test("the replay cursor is the ledger line after each ask, carrying data only; other actions are passed over", () => {
  const lines = [
    line({}),
    ask("act_00000000000a"),
    line({}),
    ask("act_00000000000b"),
  ];
  const first = nextEvent(lines, 0);
  expect(first?.event).toEqual({
    cursor: "2",
    data: {
      at: "2026-10-15T09:59:00.000Z",
      confidence: "low",
      conversation: "c1",
      id: "act_00000000000a",
      quote: "write that down in the to-dos",
      ref: "job-1:3@2026-10-15T09:59:00.000Z",
      turns: [3, 4],
    },
    eventId: "act_00000000000a",
    name: "ask",
    timestamp: "2026-10-15T09:59:00.000Z",
  });
  expect(nextEvent(lines, 2)?.cursor).toBe(4);
  expect(nextEvent(lines, 4)).toBeNull();
  // A subscriber's cursor wins (never past the end); a refresh without one keeps its place; a new one starts now.
  expect(resumeAt("2", 3, 4)).toBe(2);
  expect(resumeAt("9", 3, 4)).toBe(4);
  expect(resumeAt(null, 3, 4)).toBe(3);
  expect(resumeAt(undefined, undefined, 4)).toBe(4);
});

test("a delivery moves on after a 2xx or a 413, retries others with a growing pause up to 8 tries, and a 410 drops the subscription", () => {
  const now = Date.parse("2026-10-19T10:00:00.000Z");
  const s: State = {
    attempts: 0,
    delivered: 1,
    subscription: {
      id: "sub_1",
      refreshBefore: "2026-11-01T00:00:00.000Z",
      secret: SECRET,
      url: "https://chatgpt.com/cb",
      verifiedAt: "",
    },
  };
  expect(settle(s, 202, 2, now)).toEqual({
    ...s,
    delivered: 2,
    retryAt: undefined,
  });
  expect(settle(s, 413, 2, now).delivered).toBe(2);
  const failed = settle(s, 503, 2, now);
  expect(failed).toMatchObject({
    attempts: 1,
    delivered: 1,
    retryAt: "2026-10-19T10:01:00.000Z",
  });
  expect(settle(failed, 0, 2, now).retryAt).toBe("2026-10-19T10:02:00.000Z");
  expect(settle({ ...s, attempts: 7 }, 500, 2, now)).toMatchObject({
    attempts: 0,
    delivered: 2,
  });
  expect(settle(s, 410, 2, now)).toEqual({ attempts: 0, delivered: 1 });
});

test("a nudge or a steer goes out as its task's ask, with its own event id and the nudge or steer", () => {
  const nudge = line({
    after: { why: "not claimed 30 min after the ask" },
    at: "2026-10-15T10:20:00.000Z",
    id: "act_00000000000c",
    instruction: undefined,
    kind: "nudge",
    madeBy: "watch",
    target: "act_00000000000a",
  });
  const event = nextEvent([ask("act_00000000000a"), nudge], 1)?.event;
  expect(event?.eventId).toBe("act_00000000000c");
  expect(event?.timestamp).toBe("2026-10-15T10:20:00.000Z");
  expect(event?.data).toMatchObject({
    id: "act_00000000000a",
    nudge: {
      task: "act_00000000000a",
      why: "not claimed 30 min after the ask",
    },
    quote: "write that down in the to-dos",
  });
  // A task Atlas made from a chat is not sent back to it as an ask; its nudges are.
  const own = line({
    id: "act_00000000000a",
    kind: "ask",
    madeBy: "connector",
    target: "atlas",
  });
  expect(nextEvent([own], 0)).toBeNull();
  expect(nextEvent([own, nudge], 0)?.event.eventId).toBe("act_00000000000c");
});
