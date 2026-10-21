import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";
import { clock, unfrozen } from "./clock";
import { type Call, log } from "./log";
import { ACTIONS, digest, linesOf, parseAction } from "./memory/ledger";
import { actionFailedReport, sendReport } from "./memory/report";
import { agentName, settings } from "./settings";
import { STATE } from "./truth";

// MCP Events (https://developers.openai.com/plugins/build/mcp-events): one event, `ask`, pushed by webhook to the one
// subscriber, his ChatGPT agent Atlas. The connector answers events/list|subscribe|unsubscribe (src/mcp.ts); the
// watcher delivers (`deliver`). The cursor is a line number of memory/actions.jsonl: an event's cursor is the line
// after it, and derived/events.json (mode 600: it holds the signing secret) keeps the subscription and how far it was
// delivered, so a restart or a retry loses nothing.

const SUBSCRIPTION = join(STATE, "events.json");
/** The lifetime granted when none or a longer one is asked for. */
const TTL_MS = 30 * 24 * 3_600_000;
/** A verified callback is not challenged again for a day. */
const VERIFIED_MS = 24 * 3_600_000;
const ATTEMPTS = 8;
const BACKOFF_MS = 30_000;
const CALLBACK_ERROR = -32_015;

const AskData = z.object({
  at: z.string().describe("When he spoke (or asked), ISO"),
  confidence: z
    .enum(["high", "low"])
    .describe(
      "low: nobody was named as the speaker, or his own wake misheard as a name; confirm with him first"
    ),
  id: z.string().describe("The task's id: its ask in Life's actions ledger"),
  quote: z.string().describe("His words, from the wake turn on"),
  ref: z
    .string()
    .describe("Where the words are: a turn (`fetch` it) or session:<at>"),
  title: z.string().optional().describe("The part of his words it is"),
});

/** His agent's name, as `clientName` gives it for its calls (the `agent` setting's `client`). */
export const AGENT = agentName();
/** Who a connector call came from, by its user agent: the names he knows them by. */
export function clientName(agent: unknown) {
  const a = String(agent ?? "");
  const client = settings().agent?.client;
  if (client && a.startsWith(client)) {
    return AGENT;
  }
  return a.toLowerCase().includes("claude") ? "Claude" : a || "unknown client";
}
/** A call of his agent's daily review: `day` read by the agent, with no error (the nightly's `reviewed`, `shownDays`). */
export const isReviewCall = (e: Call) =>
  e.tool === "day" && !e.error && clientName(e.agent) === AGENT;

export const ASK_EVENT = {
  delivery: ["webhook"],
  description: `The owner asked ${AGENT} for something: he said “hey ${AGENT}, …” (heard in his recordings) or asked in a Claude session.`,
  inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  name: "ask",
  payloadSchema: z.toJSONSchema(AskData),
};

const Secret = z.string().refine((s) => {
  const key = s.startsWith("whsec_") ? Buffer.from(s.slice(6), "base64") : [];
  return key.length >= 24 && key.length <= 64;
}, "a whsec_ secret of 24 to 64 bytes");
/** Callbacks only to OpenAI's own hosts, over HTTPS: no other place can receive his asks. */
const Callback = z.url().refine((u) => {
  const { hostname, protocol } = new URL(u);
  return (
    protocol === "https:" &&
    ["openai.com", "chatgpt.com"].some(
      (h) => hostname === h || hostname.endsWith(`.${h}`)
    )
  );
}, "an https callback on openai.com or chatgpt.com");
const Ask = {
  arguments: z.object({}).strict().default({}),
  name: z.literal("ask"),
};

export const Subscribe = z.object({
  ...Ask,
  cursor: z.string().regex(/^\d+$/).nullish(),
  delivery: z.object({
    mode: z.literal("webhook"),
    secret: Secret,
    url: Callback,
  }),
  ttlMs: z.int().positive().nullish(),
});
export const Unsubscribe = z.object({
  ...Ask,
  delivery: z.object({ mode: z.literal("webhook"), url: z.string() }),
});

interface Subscription {
  id: string;
  refreshBefore: string;
  secret: string;
  url: string;
  verifiedAt: string;
}
export interface State {
  /** Failed tries of the next event, and when to try again. */
  attempts: number;
  /** Lines of the actions ledger delivered (or not to be). */
  delivered: number;
  retryAt?: string;
  subscription?: Subscription;
}

export const deliveryState = (): State =>
  existsSync(SUBSCRIPTION)
    ? JSON.parse(readFileSync(SUBSCRIPTION, "utf8"))
    : { attempts: 0, delivered: linesOf(ACTIONS).length };

function writeState(s: State) {
  writeFileSync(SUBSCRIPTION, `${JSON.stringify(s, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(SUBSCRIPTION, 0o600);
}

/** A Standard Webhooks signature: HMAC-SHA256 of `id.timestamp.body` with the secret's key. */
export const sign = (secret: string, id: string, ts: number, body: string) =>
  `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${ts}.${body}`)
    .digest("base64")}`;

/** One signed POST, signed when sent (a retry gets a new timestamp and signature). Never follows a redirect. */
const post = (s: Subscription, id: string, body: string) => {
  unfrozen("send events");
  const ts = Math.floor(clock().getTime() / 1000);
  return fetch(s.url, {
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-signature": sign(s.secret, id, ts, body),
      "webhook-timestamp": String(ts),
      "X-MCP-Subscription-Id": s.id,
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
};

/** The challenge the callback must echo before it receives anything; the reason when it does not. */
async function verify(s: Subscription) {
  const challenge = randomBytes(24).toString("base64url");
  try {
    const res = await post(
      s,
      `msg_verification_${randomBytes(12).toString("hex")}`,
      JSON.stringify({ challenge, type: "verification" })
    );
    const echo = Buffer.from(
      String(((await res.json()) as { challenge?: unknown }).challenge)
    );
    const want = Buffer.from(challenge);
    return res.ok && echo.length === want.length && timingSafeEqual(echo, want)
      ? null
      : "challenge_failed";
  } catch (e) {
    return (e as Error).name === "TimeoutError"
      ? "timeout"
      : "challenge_failed";
  }
}

/** Where delivery resumes: at the subscriber's cursor, else where a refreshed subscription was, else at the end (a new one starts now). */
export const resumeAt = (
  cursor: string | null | undefined,
  kept: number | undefined,
  length: number
) => (cursor ? Math.min(Number(cursor), length) : (kept ?? length));

/**
 * Creates or refreshes the one subscription (a new one replaces the old). Its id comes from the callback and the event
 * (the one principal is the owner: the connector lets no one else in). The cursor resumes delivery where the subscriber left off; without one a refresh keeps its place and a new
 * subscription starts now. History is never truncated: the ledger is append-only.
 */
export async function subscribe(p: z.infer<typeof Subscribe>) {
  const now = clock().getTime();
  const id = `sub_${digest("sha256", JSON.stringify([p.delivery.url, p.name, p.arguments]), 24)}`;
  const cached = deliveryState().subscription;
  const sub: Subscription = {
    id,
    refreshBefore: new Date(
      now + Math.min(p.ttlMs ?? TTL_MS, TTL_MS)
    ).toISOString(),
    secret: p.delivery.secret,
    url: p.delivery.url,
    verifiedAt: cached?.id === id ? cached.verifiedAt : "",
  };
  if (!(now - Date.parse(sub.verifiedAt) < VERIFIED_MS)) {
    const reason = await verify(sub);
    if (reason) {
      throw new ProtocolError(
        CALLBACK_ERROR as never,
        "Callback verification failed",
        { reason }
      );
    }
    sub.verifiedAt = new Date(now).toISOString();
  }
  // Read again after the challenge: the watcher may have delivered meanwhile.
  const state = deliveryState();
  const old = state.subscription?.id === id;
  const delivered = resumeAt(
    p.cursor,
    old ? state.delivered : undefined,
    linesOf(ACTIONS).length
  );
  writeState({
    ...(old ? state : { attempts: 0 }),
    delivered,
    subscription: sub,
  });
  log("mcp.call", { host: new URL(sub.url).host, tool: "events/subscribe" });
  return {
    cursor: String(delivered),
    id,
    refreshBefore: sub.refreshBefore,
    truncated: false,
  };
}

/** Stops the subscription to this callback, if it is the one; idempotent. */
export function unsubscribe(p: z.infer<typeof Unsubscribe>) {
  const state = deliveryState();
  if (state.subscription?.url === p.delivery.url) {
    writeState({ attempts: 0, delivered: state.delivered });
    log("mcp.call", { tool: "events/unsubscribe" });
  }
  return {};
}

/**
 * The next event in the ledger at or after line `from` (its cursor: the line after it), or null: an ask, not one Atlas
 * made from a chat (already its own).
 */
export function nextEvent(lines: string[], from: number) {
  for (const [k, line] of lines.slice(from).entries()) {
    const a = parseAction(line);
    if (a?.kind === "ask" && a.instruction && a.madeBy !== "connector") {
      const cursor = from + k + 1;
      const data: z.infer<typeof AskData> = {
        ...a.instruction,
        confidence: a.after.confidence === "low" ? "low" : "high",
        id: a.id,
        title: a.after.title as string | undefined,
      };
      return {
        action: a,
        cursor,
        event: {
          cursor: String(cursor),
          data,
          eventId: a.id,
          name: "ask",
          timestamp: a.instruction.at,
        },
      };
    }
  }
  return null;
}

/** Whether Atlas holds a subscription that has not expired (a retry may wait). */
const current = (s: State, now: number) =>
  Date.parse(s.subscription?.refreshBefore ?? "") >= now;
export const subscribed = (now: number) => current(deliveryState(), now);

/** Nothing goes out without a live subscription or while a retry waits. */
const live = (
  s: State,
  now: number
): s is State & { subscription: Subscription } =>
  current(s, now) && !!s.subscription && !(Date.parse(s.retryAt ?? "") > now);

/**
 * What one delivery's HTTP status (0: unreachable) does: a 2xx or a 413 (never retried) moves past the event, a 410
 * drops the subscription, anything else retries it after 1, 2, 4… minutes, and after the 8th try moves on.
 */
export function settleDelivery(
  s: State,
  status: number,
  cursor: number,
  now: number
): State {
  if (status === 410) {
    return { attempts: 0, delivered: s.delivered };
  }
  const ok = status >= 200 && status < 300;
  if (!ok && status !== 413 && s.attempts + 1 < ATTEMPTS) {
    const attempts = s.attempts + 1;
    const retryAt = new Date(now + BACKOFF_MS * 2 ** attempts).toISOString();
    return { ...s, attempts, retryAt };
  }
  return { ...s, attempts: 0, delivered: cursor, retryAt: undefined };
}

/**
 * Delivers the asks past the cursor, one POST each, in order (the watcher calls it every loop), as `settleDelivery` says; an
 * ask passed over is emailed to him like a failed action. Nothing is sent before a subscription, after it expired, or
 * while a retry waits. A subscribe during a POST wins: the state is read again before each write.
 */
export async function deliver() {
  const now = clock().getTime();
  const lines = linesOf(ACTIONS);
  for (;;) {
    const state = deliveryState();
    const next = nextEvent(lines, state.delivered);
    if (!live(state, now)) {
      return;
    }
    if (!next) {
      if (state.delivered < lines.length) {
        writeState({ ...state, delivered: lines.length });
      }
      return;
    }
    const { action, cursor, event } = next;
    // biome-ignore lint/performance/noAwaitInLoops: one event at a time, in order
    const status = await post(
      state.subscription,
      event.eventId,
      JSON.stringify(event)
    ).then(
      (r) => r.status,
      () => 0
    );
    if (JSON.stringify(deliveryState()) !== JSON.stringify(state)) {
      continue;
    }
    const after = settleDelivery(state, status, cursor, now);
    writeState(after);
    if (status >= 200 && status < 300) {
      // When Atlas got it, for `bun life asks`.
      log("event.sent", { event: event.eventId });
      continue;
    }
    const error = `${AGENT} did not receive it (callback ${status || "unreachable"})`;
    log("run.error", { error, event: event.eventId, step: "events.deliver" });
    if (after.subscription && after.delivered === cursor) {
      await sendReport(
        `action/${action.id}`,
        actionFailedReport({ ...action, error })
      );
    }
  }
}
