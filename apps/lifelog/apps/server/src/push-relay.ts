// The push relay: what an install without the app's own APNs key posts its pushes to (`apns.ts` `pusherFor`), so a
// user's server never holds that key. It composes nothing itself: `apns-request.ts` says what each kind says, and here it
// only checks that a push is ids only, keeps hourly limits per phone and per caller, and signs with the key in its env.
// Always APNs production: test tokens belong to the developer's install, which has the key.

import { clock } from "@life/server/src/core/clock";
import { Push } from "@life/server/src/core/push";
import {
  APP_TOPIC,
  apnsRequestOf,
  apnsSigner,
  type PushRequest,
  type PushResponse,
} from "./apns-request";

/** The phone's APNs token: hex, as the app uploads it. */
const TOKEN = /^[0-9a-f]{64,200}$/;
/** A push is ids only, so this is generous. */
const MAX_BODY_BYTES = 4096;
/** One phone's, and one caller's, pushes an hour: above a night's burst, below a flood. */
const PER_TOKEN = 300;
const PER_IP = 3000;
const HOUR_MS = 60 * 60 * 1000;

type Env = Record<string, string | undefined>;
type Signer = (
  path: string,
  request: Omit<PushRequest, "path">
) => Promise<PushResponse>;

const responseOf = (
  body: object,
  status: number,
  headers?: Record<string, string>
) =>
  new Response(JSON.stringify(body), {
    headers: { ...headers, "content-type": "application/json" },
    status,
  });
const badRequest = () => responseOf({ reason: "BadRequest" }, 400);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The signer from the relay's env: the app's own key, thrown at start when one is missing. */
const signerIn = (env: Env): Signer => {
  const { APNS_KEY_ID, APNS_PRIVATE_KEY, APNS_TEAM_ID } = env;
  if (!(APNS_KEY_ID && APNS_PRIVATE_KEY && APNS_TEAM_ID)) {
    throw new Error(
      "The push relay needs APNS_KEY_ID, APNS_PRIVATE_KEY and APNS_TEAM_ID."
    );
  }
  return apnsSigner({
    environment: "production",
    keyId: APNS_KEY_ID,
    privateKey: APNS_PRIVATE_KEY,
    teamId: APNS_TEAM_ID,
    topic: APP_TOPIC,
  });
};

/** The relay's `fetch`: `POST /push` with `{token, push}`, `GET /health` for Fly's check, nothing else. */
export function pushRelayOf(env: Env, signer: Signer = signerIn(env)) {
  // ponytail: counters per machine, reset hourly; a shared store if the relay ever runs several.
  const counts = new Map<string, { at: number; n: number }>();

  /** Counts one push for `key`, and whether it is past `limit` this hour. */
  const isOver = (key: string, limit: number, now: number) => {
    const before = counts.get(key);
    if (before && now - before.at < HOUR_MS) {
      const n = before.n + 1;
      counts.set(key, { at: before.at, n });
      return n > limit;
    }
    counts.set(key, { at: now, n: 1 });
    return false;
  };

  /** Drops the hours that passed, so many callers never grow the counters without end. */
  const forgetHours = (now: number) => {
    if (counts.size < 10_000) {
      return;
    }
    for (const [key, count] of counts) {
      if (now - count.at >= HOUR_MS) {
        counts.delete(key);
      }
    }
  };

  /** The push a caller sent, or the answer refusing it: ids only, `{token, push}`, 4 KB at most. */
  const pushIn = async (
    request: Request
  ): Promise<{ push: Push; token: string } | Response> => {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return responseOf({ reason: "PayloadTooLarge" }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return badRequest();
    }
    if (!(isRecord(body) && Object.keys(body).length === 2)) {
      return badRequest();
    }
    const { push: raw, token } = body;
    if (typeof token !== "string" || !TOKEN.test(token)) {
      return badRequest();
    }
    const push = Push.safeParse(raw);
    return push.success ? { push: push.data, token } : badRequest();
  };

  /** Sends it with the app's key, and answers as APNs did, its id and body taken as they came. */
  const forward = async (push: Push, token: string) => {
    // Never the token whole, never an id.
    const about = `${push.kind} ${token.slice(0, 8)}`;
    try {
      const answer = await signer(
        `/3/device/${token}`,
        apnsRequestOf(push, APP_TOPIC)
      );
      console.log(`${about} ${answer.status}`);
      return new Response(answer.body, {
        headers: answer.apnsId ? { "apns-id": answer.apnsId } : {},
        status: answer.status,
      });
    } catch (error) {
      console.log(`${about} failed ${String(error)}`);
      return responseOf({ reason: "APNsUnreachable" }, 502);
    }
  };

  return async (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      return new Response("ok");
    }
    if (pathname !== "/push" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const now = clock().getTime();
    forgetHours(now);
    // Fly's proxy, since the socket's address is Fly's own; a request it did not stamp has no caller to hold.
    const caller = request.headers.get("fly-client-ip");
    if (!caller) {
      return badRequest();
    }
    const tooMany = responseOf({ reason: "TooManyRequests" }, 429);
    if (isOver(`ip:${caller}`, PER_IP, now)) {
      return tooMany;
    }
    const taken = await pushIn(request);
    if (taken instanceof Response) {
      return taken;
    }
    return isOver(`token:${taken.token}`, PER_TOKEN, now)
      ? tooMany
      : await forward(taken.push, taken.token);
  };
}

if (import.meta.main) {
  Bun.serve({
    fetch: pushRelayOf(process.env),
    port: Number(process.env.PORT ?? 8080),
  });
}
