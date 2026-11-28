// One push to the phone, as APNs takes it: signed with the app's .p8 key, and composed from what a push may say
// (`@life/server/src/core/push`). No database, no events: the push relay runs this file alone.

import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { connect } from "node:http2";
import { clock } from "@life/server/src/core/clock";
import type { Push } from "@life/server/src/core/push";

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
export type Transport = (
  origin: string,
  request: PushRequest
) => Promise<PushResponse>;

/** The app's bundle id, its pushes' topic: a copy of `LIFELOG_BUNDLE_ID` (apps/ios/project.yml), the one on this side. */
export const APP_TOPIC = "com.ericedouard.lifelog";

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

/** Sends one push of `topic` to APNs, signed with the app's own key, `path` being the device's. */
export function apnsSigner(
  {
    environment,
    keyId,
    privateKey,
    teamId,
    topic,
  }: {
    environment: keyof typeof ORIGINS;
    keyId: string;
    privateKey: string;
    teamId: string;
    topic: string;
  },
  transport: Transport = http2Post
) {
  const key = createPrivateKey(privateKey);
  const origin = ORIGINS[environment];
  let issuedAt = 0;
  let token = "";
  return (path: string, request: Omit<PushRequest, "path">) => {
    const now = Math.floor(clock().getTime() / 1000);
    if (now - issuedAt >= TOKEN_RENEW_S) {
      issuedAt = now;
      token = providerToken(key, keyId, teamId, now);
    }
    return transport(origin, {
      ...request,
      headers: {
        "apns-topic": topic,
        ...request.headers,
        authorization: `bearer ${token}`,
      },
      path,
    });
  };
}

/** The words an alert shows, per kind: the one place they live (a card's own text is written by the phone, from the connector). */
const ALERTS: Record<
  Exclude<Push["kind"], "cards.removed" | "voice.ready">,
  { body: string; category?: string; thread?: string; title: string }
> = {
  "calendar.added": {
    body: "Added to your calendar",
    category: "life.calendar",
    title: "Life",
  },
  "card.new": {
    body: "New card",
    category: "life.card",
    thread: "life-cards",
    title: "Life",
  },
  "thread.answered": { body: "Open Life to read it.", title: "Life answered" },
  "thread.failed": {
    body: "Open Life to read it.",
    title: "Life couldn't do it",
  },
  "thread.heard": { body: "On it.", title: "Life heard you" },
  "voice.waiting": {
    body: "Your Pendant has audio waiting to sync.",
    title: "Open lifelog",
  },
};

const backgroundOf = (
  topic: string,
  fields: Record<string, unknown>
): Omit<PushRequest, "path"> => ({
  body: JSON.stringify({ aps: { "content-available": 1 }, ...fields }),
  headers: {
    "apns-priority": "5",
    "apns-push-type": "background",
    "apns-topic": topic,
  },
});

/**
 * One push, composed: what it says and how it interrupts. An alert carries the kind's fixed words, `level` as Apple's
 * `interruption-level` (a passive one makes no sound), and the app's own `kind` beside `aps` when it has a `pushId`:
 * the phone routes on it and names it among his notifications (`apns-collapse-id`), and a card's or an appointment's
 * category lets it rewrite the words from the connector. A background push has no alert, sound or badge (Apple refuses
 * them on one) and goes at priority 5, where iOS may hold it: what it says is also read in the foreground.
 */
export const apnsRequestOf = (
  push: Push,
  topic: string
): Omit<PushRequest, "path"> => {
  if (push.kind === "cards.removed") {
    return backgroundOf(topic, { removed: push.removed });
  }
  if (push.kind === "voice.ready") {
    return backgroundOf(topic, { lifelog: "processing" });
  }
  const { body, category, thread, title } = ALERTS[push.kind];
  const pushId = "pushId" in push ? push.pushId : undefined;
  const level = "level" in push ? push.level : undefined;
  return {
    body: JSON.stringify({
      aps: {
        alert: { body, title },
        ...(category ? { category, "mutable-content": 1 } : {}),
        ...(thread ? { "thread-id": thread } : {}),
        ...(level ? { "interruption-level": level } : {}),
        ...(level === "passive" ? {} : { sound: "default" }),
      },
      ...(pushId ? { kind: push.kind, pushId } : {}),
    }),
    headers: {
      ...(pushId ? { "apns-collapse-id": pushId } : {}),
      "apns-priority": "10",
      "apns-push-type": "alert",
      "apns-topic": topic,
    },
  };
};
