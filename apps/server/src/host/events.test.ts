import { expect, test } from "bun:test";
import { HOUR } from "../core/clock";
import { AGENT_WORD } from "../core/names";
import { readSettings, type Settings, setSettings } from "../core/settings";
import { action } from "../memory/record-fixtures";
import {
  agentLive,
  nextEvent,
  resumeAt,
  type State,
  Subscribe,
  settleDelivery,
  sign,
} from "./events";

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
    target: AGENT_WORD,
    via: "watch",
  });

test("the replay cursor is the ledger line after each ask, carrying data only (its turn ref, not the positions the ledger keeps); other actions are passed over", () => {
  const lines = [
    line({}),
    ask("entry_00000000000a"),
    line({}),
    ask("entry_00000000000b"),
  ];
  const first = nextEvent(lines, 0);
  expect(first?.event).toEqual({
    cursor: "2",
    data: {
      at: "2026-10-15T09:59:00.000Z",
      confidence: "low",
      id: "entry_00000000000a",
      quote: "write that down in the to-dos",
      ref: "job-1:3@2026-10-15T09:59:00.000Z",
    },
    eventId: "entry_00000000000a",
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
  expect(settleDelivery(s, 202, 2, now)).toEqual({
    ...s,
    delivered: 2,
    retryAt: undefined,
  });
  expect(settleDelivery(s, 413, 2, now).delivered).toBe(2);
  const failed = settleDelivery(s, 503, 2, now);
  expect(failed).toMatchObject({
    attempts: 1,
    delivered: 1,
    retryAt: "2026-10-19T10:01:00.000Z",
  });
  expect(settleDelivery(failed, 0, 2, now).retryAt).toBe(
    "2026-10-19T10:02:00.000Z"
  );
  expect(settleDelivery({ ...s, attempts: 7 }, 500, 2, now)).toMatchObject({
    attempts: 0,
    delivered: 2,
  });
  expect(settleDelivery(s, 410, 2, now)).toEqual({ attempts: 0, delivered: 1 });
});

test("only asks go out, not one Orbit made from a chat; old nudge and steer lines parse and go nowhere", () => {
  const old = (kind: "nudge" | "steer", id: string) =>
    line({
      after: {},
      id,
      instruction: undefined,
      kind,
      target: "entry_00000000000a",
      via: "watch",
    });
  const lines = [ask("entry_00000000000a"), old("nudge", "entry_00000000000c")];
  expect(nextEvent(lines, 0)?.event.eventId).toBe("entry_00000000000a");
  expect(
    nextEvent([...lines, old("steer", "entry_00000000000d")], 1)
  ).toBeNull();
  const own = line({
    id: "entry_00000000000a",
    kind: "ask",
    target: AGENT_WORD,
    via: "connector",
  });
  expect(nextEvent([own], 0)).toBeNull();
});

test("an agent that pulls its asks is live while it reads tasks: a day without a call is a lapse", async () => {
  const before = readSettings().agent as NonNullable<Settings["agent"]>;
  const now = Date.parse("2026-10-22T10:00:00Z");
  const call = (tool: string, hours: number, agent = "openai-mcp/1") => ({
    agent,
    at: new Date(now - hours * HOUR).toISOString(),
    tool,
  });
  try {
    setSettings({ agent: { ...before, transport: "pull" } });
    expect(
      await agentLive(now, async () => [call("read_open_agent_tasks", 2)])
    ).toBe(true);
    expect(
      await agentLive(now, async () => [call("read_open_agent_tasks", 30)])
    ).toBe(false);
    expect(await agentLive(now, async () => [call("read_day", 2)])).toBe(false);
    expect(
      await agentLive(now, async () => [
        call("read_open_agent_tasks", 2, "curl/8"),
      ])
    ).toBe(false);
  } finally {
    setSettings({ agent: before });
  }
});
