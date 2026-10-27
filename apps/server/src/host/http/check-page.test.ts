import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { LIFE_CODE_DIR } from "../../core/paths";
import { connector } from "../../core/settings";
import { changeFeed } from "../../memory/changes";
import {
  RATINGS,
  ratedOutdated,
  readCorrections,
  readRatings,
} from "../../memory/ledger";
import { ownerTokens } from "./auth";
import { createCheck } from "./check-page";
import { PAGES_CLIENT } from "./oauth";
import { createSignIn } from "./signin";

const { origin: ORIGIN, resource: RESOURCE } = connector();
const ISSUER = `${ORIGIN}/auth`;

const SESSION_COOKIE =
  /^__Host-life=.+; Path=\/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax$/;
const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  extractable: true,
});
const jwk: JWK = { ...(await exportJWK(publicKey)), alg: "EdDSA", kid: "k1" };
const verify = ownerTokens({
  issuer: ISSUER,
  jwks: createLocalJWKSet({ keys: [jwk] }),
  ownerSub: "owner",
  resource: RESOURCE,
});
const token = (sub = "owner") =>
  new SignJWT({ aud: RESOURCE, iss: ISSUER, scope: "life:read", sub })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

/** The issuer's token endpoint: Life's own client and a good code with its verifier get `issued`'s token. */
let issued = "owner";
const issuer = {
  app: new Hono().post("/auth/oauth2/token", async (c) => {
    const form = new URLSearchParams(await c.req.text());
    return form.get("code") === "good" &&
      form.get("code_verifier") &&
      form.get("client_id") === PAGES_CLIENT
      ? Response.json({ access_token: await token(issued), expires_in: 3600 })
      : new Response("bad", { status: 400 });
  }),
  issuer: ISSUER,
};
const check = createCheck(createSignIn(verify, issuer));

const get = async (path: string, cookie = "", init: RequestInit = {}) =>
  (await check.request(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { cookie, ...(init.headers as object) },
    })
  )) as Response;
afterAll(() => rm(RATINGS, { force: true }));

const IMPORT = /@import url\("([^"]+)"/;

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
  const { groups } = (await ok.json()) as {
    groups: { name: string; statements: { asOf: string }[] }[];
  };
  expect(groups.map((g) => g.name)).toEqual(["Events"]);
  // Each card says when its claim dates from: the made-up statement's day, with its year unless it is this one's.
  const year = new Date().getFullYear() === 2026 ? "" : " 2026";
  expect(groups[0]?.statements[0]?.asOf).toBe(`12 Oct${year}`);
  expect((await check.request(new Request(`${ORIGIN}/mcp`))).status).toBe(404);
});

test("the page's policy lets in the fonts its stylesheet imports", async () => {
  const css = await Bun.file(
    join(LIFE_CODE_DIR, "assets", "check", "check.css")
  ).text();
  const host = new URL(css.match(IMPORT)?.[1] ?? "").origin;
  expect(
    (await get("/check/")).headers.get("content-security-policy")
  ).toContain(host);
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

test("an answer must come from Life's own page and name a statement; a false hides its claim and an outdated retires it, until he takes it back", async () => {
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
        ref: "obs_000000000000",
      })
    ).status
  ).toBe(400);
  expect(
    (await post(ORIGIN, { answer: "false", ref: "obs_000000000000" })).status
  ).toBe(400);
  // The made-up statement (apps/server/src/test-data): saved, and hidden as wrong until he takes it back.
  const claim = "obs_00000000000a";
  const wrong = async () =>
    (await readCorrections()).some(
      (c) => c.kind === "wrong" && c.observations.includes(claim)
    );
  expect((await post(ORIGIN, { answer: "false", ref: claim })).status).toBe(
    204
  );
  expect(await wrong()).toBe(true);
  expect((await post(ORIGIN, { answer: null, ref: claim })).status).toBe(204);
  expect(await wrong()).toBe(false);
  // Outdated: closed as history (a retirement, ledger.test.ts), not wrong.
  const closed = () =>
    ratedOutdated(readRatings()).find(
      (c) => c.kind === "outdated" && c.observations.includes(claim)
    )?.note ?? null;
  expect((await post(ORIGIN, { answer: "outdated", ref: claim })).status).toBe(
    204
  );
  expect([await wrong(), closed()]).toEqual([false, "rated outdated"]);
  expect((await post(ORIGIN, { answer: null, ref: claim })).status).toBe(204);
  expect(closed()).toBe(null);
  const feed = await changeFeed({ types: ["rating"] });
  expect(feed.items.map((i) => i.type)).toEqual([
    "rating.false",
    "rating.undone",
    "rating.outdated",
    "rating.undone",
  ]);
});
