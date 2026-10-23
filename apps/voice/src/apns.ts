// Pushes to the phone through APNs: silent pushes when processing has news, and alerts (the people
// digest). Token auth: an ES256 JWT signed with the .p8 key, over HTTP/2.
import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { connect } from "node:http2";
import type { Db } from "@life/voice-db";
import { alertPushToken } from "@life/voice-db/schema";
import { eq } from "drizzle-orm";
import type { Config } from "./config";
import { type Fields, record, tokenPrefix } from "./events";

export interface PushRequest {
  body: string;
  headers: Record<string, string>;
  path: string;
}
export interface PushResponse {
  // APNs' id for the notification, to quote to Apple.
  apnsId?: string | undefined;
  body: string;
  status: number;
}
// Sends one request to APNs, signed and addressed.
export type Pusher = (request: PushRequest) => Promise<PushResponse>;
type Transport = (
  origin: string,
  request: PushRequest
) => Promise<PushResponse>;

const ORIGINS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;
// Apple refuses a provider token older than an hour and one renewed more often than every
// 20 minutes.
const TOKEN_RENEW_S = 30 * 60;
const TIMEOUT_MS = 10_000;

function providerToken(
  key: KeyObject,
  keyId: string,
  teamId: string,
  issuedAt: number
) {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${part({ alg: "ES256", kid: keyId })}.${part({ iat: issuedAt, iss: teamId })}`;
  const signature = sign("sha256", Buffer.from(input), {
    dsaEncoding: "ieee-p1363",
    key,
  });
  return `${input}.${signature.toString("base64url")}`;
}

// ponytail: one HTTP/2 connection per push, fine at ~100 a day; keep a session open if
// pushes ever come in bursts (Apple frowns on rapid reconnects).
const http2Post: Transport = (origin, request) =>
  new Promise((resolve, reject) => {
    const session = connect(origin);
    session.setTimeout(TIMEOUT_MS, () =>
      session.destroy(new Error("APNs timed out"))
    );
    session.on("error", reject);
    const stream = session.request({
      ":method": "POST",
      ":path": request.path,
      ...request.headers,
    });
    let status = 0;
    let apnsId: string | undefined;
    let body = "";
    stream.setEncoding("utf8");
    stream.on("response", (headers) => {
      status = Number(headers[":status"]);
      apnsId = headers["apns-id"]?.toString();
    });
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("end", () => {
      session.close();
      resolve({ apnsId, body, status });
    });
    stream.on("error", reject);
    stream.end(request.body);
  });

// Null without a key.
export function apnsFor(
  config: Config,
  transport: Transport = http2Post
): Pusher | null {
  const { APNS_KEY_ID, APNS_PRIVATE_KEY, APNS_TEAM_ID } = config;
  if (!(APNS_KEY_ID && APNS_PRIVATE_KEY && APNS_TEAM_ID)) {
    return null;
  }
  const key = createPrivateKey(APNS_PRIVATE_KEY);
  const origin = ORIGINS[config.APNS_ENVIRONMENT];
  let issuedAt = 0;
  let token = "";
  return (request) => {
    const now = Math.floor(Date.now() / 1000);
    if (now - issuedAt >= TOKEN_RENEW_S) {
      issuedAt = now;
      token = providerToken(key, APNS_KEY_ID, APNS_TEAM_ID, now);
    }
    return transport(origin, {
      ...request,
      headers: {
        "apns-topic": config.APNS_TOPIC,
        ...request.headers,
        authorization: `bearer ${token}`,
      },
    });
  };
}

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

// Sends one push to the phone's latest token and records it: `apns.sent` with what it was for,
// APNs' status, id and reason, and the token's first characters; `apns.failed` when no answer
// came; `apns.skipped` without a key or a token. A token APNs calls dead (410: the app was
// removed; or BadDeviceToken) is dropped, unless a fresh one already replaced it: pushes wait for
// the phone's next token instead of failing on the old one. Never throws.
export async function sendPush(
  db: Db,
  push: Pusher | null,
  kind: string,
  request: Omit<PushRequest, "path">,
  fields: Fields = {}
) {
  let about: Fields = { kind, ...fields };
  const started = Date.now();
  try {
    const pushToken = push && latestPushToken(db);
    if (!(push && pushToken)) {
      record(db, "apns.skipped", {
        ...about,
        reason: push ? "no_token" : "no_key",
      });
      return;
    }
    about = { ...about, token: tokenPrefix(pushToken) };
    const response = await push({
      ...request,
      path: `/3/device/${pushToken}`,
    });
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
      ms: Date.now() - started,
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

// A silent push telling the phone a transcript or a summary is ready, so it collects it now
// instead of at its next poll, or that it holds audio to send (`upload`, latency.ts askForUploads).
// Background pushes go at priority 5: iOS may hold or drop them, and the phone still polls while it
// waits on the server. `open` is the visible one: it asks the owner to open the app, and says how
// long the Pendant's audio has waited (`behindSeconds`). Never throws.
export function phoneNudger(db: Db, push: Pusher | null, bundleId: string) {
  return (
    ready: "open" | "resumed" | "summary" | "transcript" | "upload",
    fields: Fields = {}
  ) =>
    sendPush(
      db,
      push,
      "processing",
      {
        body: JSON.stringify(
          ready === "open"
            ? {
                aps: {
                  alert: {
                    body: `Your Pendant has ${Math.round(Number(fields.behindSeconds) / 60)} minutes waiting to sync.`,
                    title: "Open lifelog",
                  },
                  sound: "default",
                },
              }
            : { aps: { "content-available": 1 }, lifelog: "processing" }
        ),
        headers: {
          "apns-priority": ready === "open" ? "10" : "5",
          "apns-push-type": ready === "open" ? "alert" : "background",
          "apns-topic": bundleId,
        },
      },
      { ready, ...fields }
    );
}

export type Nudge = ReturnType<typeof phoneNudger>;
