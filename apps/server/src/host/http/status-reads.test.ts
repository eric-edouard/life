import { expect, test } from "bun:test";
import { keyRefusal, localKey } from "./signin";
import { createStatusReads } from "./status-reads";

// The app's status reads answer only with the local key, as a bearer.
const reads = createStatusReads(keyRefusal());
const LAST_PART = /[^.]+$/;
const get = (path: string, headers: Record<string, string> = {}) =>
  reads.request(new Request(`http://127.0.0.1:46201${path}`, { headers }));

test("the app's reads open with the local key only", async () => {
  const key = localKey();
  const as = (token: string) =>
    get("/status/card/tasks", { authorization: `Bearer ${token}` });
  expect((await as(key))?.status).toBe(200);
  expect((await as(`${key.slice(1)}x`))?.status).toBe(401);
  // As many characters as the key, more bytes: refused, not a crash.
  expect((await as("é".repeat(key.length)))?.status).toBe(401);
  expect((await get("/status/card/tasks"))?.status).toBe(401);
  // No page any more: nothing else is answered here.
  expect((await get("/")).status).toBe(404);
  // A card with no id is no card.
  const none = await get("/status/card", { authorization: `Bearer ${key}` });
  expect(none.status).toBe(404);
});

test("a history that doesn't page back offers no older page: the tasks and the Mac's day are whole", async () => {
  const { detail } = await import("../status/snapshot-detail");
  expect((await detail("tasks")).next.history).toBeNull();
});

test("the status page: nothing before the owner's sign-in, which comes back to it; the same snapshot after", async () => {
  const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } =
    await import("jose");
  const { connector } = await import("../../core/settings");
  const { ownerTokens } = await import("./auth");
  const { createSignIn } = await import("./signin");
  const { createStatusPage } = await import("./status-reads");
  const { issuer, origin, resource } = connector();
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const jwk = { ...(await exportJWK(publicKey)), alg: "EdDSA", kid: "k1" };
  const token = () =>
    new SignJWT({
      aud: resource,
      iss: issuer,
      scope: "life:read",
      sub: "owner",
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  const signIn = createSignIn(
    ownerTokens({
      issuer,
      jwks: createLocalJWKSet({ keys: [jwk] }),
      ownerSub: "owner",
      resource,
    }),
    async () =>
      Response.json({
        access_token: await token(),
        expires_in: 3600,
      })
  );
  const page = createStatusPage(signIn);
  const check = signIn.routes;
  const at = (app: typeof page, path: string, cookie = "") =>
    app.request(new Request(`${origin}${path}`, { headers: { cookie } }));

  const session = `__Host-life=${await token()}`;
  const first = await at(page, "/status/");
  expect(first.status).toBe(302);
  expect(first.headers.get("location")).toContain(`${issuer}/oauth2/authorize`);
  expect((await at(page, "/status/snapshot")).status).toBe(401);
  // Without its slash, the page's address still goes to the page, never to a read's 401.
  expect((await at(page, "/status")).headers.get("location")).toBe("/status/");
  // The page reads the snapshot only: a card's detail stays on the local port.
  expect((await at(page, "/status/card/tasks", session)).status).toBe(404);
  expect((await at(page, "/status/status.js")).status).toBe(401);

  // Back from the issuer to the page that sent him, and only to a page of this site.
  const state = new URL(first.headers.get("location") ?? "").searchParams.get(
    "state"
  );
  const login = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const back = await at(check, `/check/callback?code=c&state=${state}`, login);
  expect(back.headers.get("location")).toBe("/status/");
  const forged = login.replace(LAST_PART, "//elsewhere/");
  const kept = await at(check, `/check/callback?code=c&state=${state}`, forged);
  expect(kept.headers.get("location")).toBe("/check/");

  expect((await at(page, "/status/", session)).status).toBe(200);
  const snap = await at(page, "/status/snapshot", session);
  expect(snap.status).toBe(200);
  expect(
    ((await snap.json()) as { cards: unknown[] }).cards.length
  ).toBeGreaterThan(0);
}, 30_000);
