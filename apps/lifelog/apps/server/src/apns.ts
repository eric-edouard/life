// Pushes to the phone: background pushes when processing has news, and alerts (a card, an appointment, a voice ask
// heard). An install holding the app's own .p8 key (the developer's) signs and sends them itself; every other one posts
// them to the push relay (`push-relay.ts`), which holds that key. Token auth: an ES256 JWT, over HTTP/2.

import type { Push } from "@life/server/src/core/push";
import type { Db } from "@lifelog/db";
import { alertPushToken } from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import {
  apnsRequestOf,
  apnsSigner,
  type PushResponse,
  type Transport,
} from "./apns-request";
import type { Config } from "./config";
import { type Fields, record, tokenPrefix } from "./events";

/** Where an install without the app's own key posts its pushes: the relay holds the key, and always sends to APNs production. */
export const PUSH_RELAY = "https://life-push.fly.dev/push";
const RELAY_TIMEOUT_MS = 10_000;

/** Sends one push to the phone's token, as APNs answers. */
export type Pusher = (token: string, push: Push) => Promise<PushResponse>;

// The phone's push token, one row (`alert_push_token`), for alerts and silent pushes alike.
export function storePushToken(db: Db, pushToken: string) {
  db.insert(alertPushToken)
    .values({ id: 1, pushToken })
    .onConflictDoUpdate({ set: { pushToken }, target: alertPushToken.id })
    .run();
}

export function latestPushToken(db: Db) {
  const row = db
    .select({ pushToken: alertPushToken.pushToken })
    .from(alertPushToken)
    .where(eq(alertPushToken.id, 1))
    .get();
  return row?.pushToken ?? null;
}

/**
 * The push relay's answer, taken as APNs' own: its status, body and `apns-id`. Privacy (SECURITY.md, "What leaves the
 * Mac"): what leaves here is the device's push token, the push's kind, its ids and its level, to Life's push relay on
 * Fly, which signs it with the app's key and sends it on to Apple's APNs; nothing else of his. Turning notifications off
 * for the app on the phone turns this off.
 */
const relayPusher: Pusher = async (token, push) => {
  const response = await fetch(PUSH_RELAY, {
    body: JSON.stringify({ push, token }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  return {
    apnsId: response.headers.get("apns-id") ?? undefined,
    body: await response.text(),
    status: response.status,
  };
};

// With the app's own key (the developer's install only, never a user's) it sends itself; otherwise through the relay.
// `transport` is the test's way to see the request.
export function pusherFor(config: Config, transport?: Transport): Pusher {
  const {
    APNS_ENVIRONMENT,
    APNS_KEY_ID,
    APNS_PRIVATE_KEY,
    APNS_TEAM_ID,
    APNS_TOPIC,
  } = config;
  if (!(APNS_KEY_ID && APNS_PRIVATE_KEY && APNS_TEAM_ID)) {
    return relayPusher;
  }
  const sign = apnsSigner(
    {
      environment: APNS_ENVIRONMENT,
      keyId: APNS_KEY_ID,
      privateKey: APNS_PRIVATE_KEY,
      teamId: APNS_TEAM_ID,
      topic: APNS_TOPIC,
    },
    transport
  );
  return (token, push) =>
    sign(`/3/device/${token}`, apnsRequestOf(push, APNS_TOPIC));
}

// Sends one push to the phone's latest token and records it: `apns.sent` with what it was for,
// APNs' status, id and reason, and the token's first characters; `apns.failed` when no answer
// came; `apns.skipped` without a pusher or a token. A token APNs calls dead (410: the app was
// removed; or BadDeviceToken) is dropped, unless a fresh one already replaced it: pushes wait for
// the phone's next token instead of failing on the old one. Never throws.
export async function sendPush(
  db: Db,
  pusher: Pusher | null,
  kind: string,
  push: Push,
  fields: Fields = {}
) {
  let about: Fields = { kind, ...fields };
  const started = performance.now();
  try {
    const pushToken = pusher && latestPushToken(db);
    if (!(pusher && pushToken)) {
      record(db, "apns.skipped", {
        ...about,
        reason: pusher ? "no_token" : "no_key",
      });
      return;
    }
    about = { ...about, token: tokenPrefix(pushToken) };
    const response = await pusher(pushToken, push);
    const reason = response.status === 200 ? null : reasonOf(response.body);
    if (response.status === 410 || reason === "BadDeviceToken") {
      db.delete(alertPushToken)
        .where(eq(alertPushToken.pushToken, pushToken))
        .run();
      record(db, "apns.token_dropped", about);
    }
    record(db, "apns.sent", {
      ...about,
      apnsId: response.apnsId ?? null,
      ms: Math.round(performance.now() - started),
      reason,
      status: response.status,
    });
  } catch (error) {
    record(db, "apns.failed", { ...about, error: String(error) });
  }
}

// APNs answers a refusal with {"reason": "BadDeviceToken"}.
function reasonOf(body: string) {
  try {
    return String(JSON.parse(body).reason);
  } catch {
    return body.slice(0, 100);
  }
}

// A notice another app of the owner's asks for (Life: each card, an appointment it added, each voice ask it heard, the
// cards that left its inbox), recorded as kind `notice`. Never throws.
export const phoneNotice = (db: Db, pusher: Pusher | null) => (notice: Push) =>
  sendPush(db, pusher, "notice", notice);

export type Notice = ReturnType<typeof phoneNotice>;

/** What a nudge is for: a transcript or a summary is ready, audio waits to be sent, the Mac checked in, or (`open`) the phone should wake him. */
type NudgeReason =
  | "check_in"
  | "open"
  | "resumed"
  | "summary"
  | "transcript"
  | "upload";

// A silent push telling the phone a transcript or a summary is ready, so it collects it now
// instead of at its next poll, or that it holds audio to send (`upload`, latency.ts askForUploads),
// or the Mac's check-in every 15 minutes (`check_in`): the phone answers with a heartbeat (what the
// owner is doing now, for Life) and moves its "Life hasn't checked in" notice further.
// Background pushes go at priority 5: iOS may hold or drop them, and the phone still polls while it
// waits on the server. `open` is the visible one: it asks the owner to open the app, as the Pendant
// holds audio to sync. Never throws.
export function phoneNudger(db: Db, pusher: Pusher | null) {
  return (ready: NudgeReason, fields: Fields = {}) =>
    sendPush(
      db,
      pusher,
      "processing",
      ready === "open" ? { kind: "voice.waiting" } : { kind: "voice.ready" },
      { ready, ...fields }
    );
}

export type Nudge = ReturnType<typeof phoneNudger>;
