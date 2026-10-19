import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { CHECK_CLIENT, ISSUER, ORIGIN, ownerTokens, RESOURCE } from "./auth";
import { createCheck } from "./check";
import { changeFeed } from "./memory/feed";
import { RATINGS, readCorrections } from "./memory/ledger";

const SESSION_COOKIE =
  /^__Host-life=.+; Path=\/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax$/;
const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  extractable: true,
});
const jwk: JWK = { ...(await exportJWK(publicKey)), alg: "EdDSA", kid: "k1" };
const verify = ownerTokens({
  jwks: createLocalJWKSet({ keys: [jwk] }),
  ownerSub: "owner",
});
const token = (sub = "owner") =>
  new SignJWT({ aud: RESOURCE, iss: ISSUER, scope: "life:read", sub })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

/** lifelog's token endpoint: Life's own client and a good code with its verifier get `issued`'s token. */
let issued = "owner";
const lifelog = (async (_url: string, init?: RequestInit) => {
  const form = new URLSearchParams(String(init?.body));
  return form.get("code") === "good" &&
    form.get("code_verifier") &&
    form.get("client_id") === CHECK_CLIENT
    ? Response.json({ access_token: await token(issued), expires_in: 3600 })
    : new Response("bad", { status: 400 });
}) as typeof fetch;
const check = createCheck(verify, lifelog);

const get = async (path: string, cookie = "", init: RequestInit = {}) =>
  (await check.handle(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { cookie, ...(init.headers as object) },
    })
  )) as Response;
afterAll(() => rm(RATINGS, { force: true }));

const session = async (sub = "owner") => `__Host-life=${await token(sub)}`;

test("nothing of his without the owner's token: the page sends him to sign in, the data says 401, another account 403", async () => {
  expect((await get("/check")).headers.get("location")).toBe("/check/");
  const page = await get("/check/");
  expect(page.status).toBe(302);
  expect(page.headers.get("location")).toContain(`${ISSUER}/oauth2/authorize`);
  expect((await get("/check/statements")).status).toBe(401);
  expect((await get("/check/check.js", "__Host-life=forged")).status).toBe(401);
  expect((await get("/check/statements", await session("other"))).status).toBe(
    403
  );
  const ok = await get("/check/statements", await session());
  expect(ok.status).toBe(200);
  const { groups } = (await ok.json()) as { groups: { name: string }[] };
  expect(groups.map((g) => g.name)).toEqual(["Events"]);
  expect(await check.handle(new Request(`${ORIGIN}/mcp`))).toBeNull();
});

test("sign-in: PKCE with a state cookie; only the owner's token becomes the session cookie", async () => {
  const login = await get("/check/login");
  const url = new URL(login.headers.get("location") ?? "");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("resource")).toBe(RESOURCE);
  const state = url.searchParams.get("state");
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toStartWith(`__Host-life-login=${state}.`);

  expect(
    (await get("/check/callback?code=good&state=forged", cookie)).status
  ).toBe(400);
  const back = await get(`/check/callback?code=good&state=${state}`, cookie);
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe("/check/");
  const set = back.headers.getSetCookie();
  expect(set[0]).toMatch(SESSION_COOKIE);

  issued = "other";
  expect(
    (await get(`/check/callback?code=good&state=${state}`, cookie)).status
  ).toBe(403);
  issued = "owner";
});

test("an answer must come from Life's own page and name a statement; a false hides its claim until he takes it back", async () => {
  const post = async (origin: string, body: object) =>
    get("/check/answer", await session(), {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    });
  expect(
    (
      await post("https://evil.example", {
        answer: "false",
        claim: "obs_000000000000",
      })
    ).status
  ).toBe(400);
  expect(
    (await post(ORIGIN, { answer: "false", claim: "obs_000000000000" })).status
  ).toBe(400);
  // The made-up statement (src/test-data): saved, and hidden as wrong until he takes it back.
  const claim = "obs_00000000000a";
  const wrong = async () =>
    (await readCorrections()).some(
      (c) => c.kind === "wrong" && c.observations.includes(claim)
    );
  expect((await post(ORIGIN, { answer: "false", claim })).status).toBe(204);
  expect(await wrong()).toBe(true);
  expect((await post(ORIGIN, { answer: null, claim })).status).toBe(204);
  expect(await wrong()).toBe(false);
  const feed = await changeFeed({ types: ["rating"] });
  expect(feed.items.map((i) => i.type)).toEqual([
    "rating.false",
    "rating.undone",
  ]);
});
