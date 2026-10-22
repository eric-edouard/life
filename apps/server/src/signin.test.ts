import { expect, test } from "bun:test";
import type { Verify } from "./auth";
import { connector } from "./settings";
import { createSignIn } from "./signin";

const { origin } = connector();
/** Only "fresh" is a live session. */
const verify = (async (token: string) =>
  token === "fresh"
    ? { clientId: "life", scopes: ["life:read"] }
    : { refusal: "invalid" as const, why: "expired" }) as Verify;

const post = (cookie: string) =>
  new Request(`${origin}/check/answer`, {
    body: "{}",
    headers: { cookie },
    method: "POST",
  });

test("a session that ran out is renewed with its refresh token: the same request again, with the new cookies", async () => {
  const signIn = createSignIn(verify, async (_url, init) =>
    new URLSearchParams(String(init.body)).get("refresh_token") === "r1"
      ? Response.json({
          access_token: "fresh",
          expires_in: 3600,
          refresh_token: "r2",
        })
      : new Response("no", { status: 400 })
  );
  const res = (await signIn.refusal(
    post("__Host-life=old; __Host-life-refresh=r1")
  )) as Response;
  // 307: a rating posted as the session ran out is posted again.
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("/check/answer");
  const cookies = res.headers.getSetCookie().join(" ");
  expect(cookies).toContain("__Host-life=fresh");
  expect(cookies).toContain("__Host-life-refresh=r2");

  // A refresh token the issuer refuses is dropped, not tried again on every request.
  const refused = (await signIn.refusal(
    post("__Host-life=old; __Host-life-refresh=spent")
  )) as Response;
  expect(refused.status).toBe(401);
  expect(refused.headers.get("set-cookie")).toContain("__Host-life-refresh=;");

  // The issuer out of reach: a 503, and the refresh token kept for when it is back.
  const down = createSignIn(verify, () => Promise.reject(new Error("down")));
  const away = (await down.refusal(post("__Host-life-refresh=r1"))) as Response;
  expect(away.status).toBe(503);
  expect(away.headers.get("set-cookie")).toBeNull();
});
