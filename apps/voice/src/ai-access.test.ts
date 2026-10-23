// Life's OAuth (@life/voice-auth): a client registered by dynamic registration signs the owner in and
// gets a token whose audience is Life, signed with the keys this server publishes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { authFor, LIFE_SCOPE, lifeResource, setOwner } from "@life/voice-auth";
import { sql } from "drizzle-orm";
import { createApp } from "./app";
import { authSettings } from "./config";
import { services } from "./services";
import { testConfig, testDb } from "./testing";

let env: Awaited<ReturnType<typeof testDb>>;
let server: ReturnType<typeof Bun.serve> | undefined;
let app: ReturnType<typeof createApp>;
let base: string;
const OWNER = {
  email: "owner@example.com",
  password: "a long test passphrase",
};
const LIFE_URL = "https://life.example.com";
const LIFE = lifeResource(LIFE_URL);

beforeAll(async () => {
  env = testDb();
  // A real server: tokens are checked against the server's own published keys.
  server = Bun.serve({ fetch: (req) => app.fetch(req), port: 0 });
  base = `http://localhost:${server.port}`;
  const config = testConfig("http://localhost:1", {
    AUTH_SECRET: "x".repeat(32),
    LIFE_URL,
    PUBLIC_BASE_URL: base,
  });
  const auth = authFor(authSettings(config), env.db);
  if (!auth) {
    throw new Error("Life's sign-in is off");
  }
  app = createApp(
    services(config, env.db, { auth, intelligence: null, search: null })
  );
  await setOwner(auth, OWNER.email, OWNER.password);
}, 30_000);
afterAll(() => {
  server?.stop(true);
  env?.drop();
});

// The flow ChatGPT and Claude run once Life's MCP sends them here: register, authorize, sign in,
// consent, swap the code.
async function connect(as: {
  authorization_endpoint: string;
  registration_endpoint: string;
  token_endpoint: string;
}) {
  const redirectUri = "http://localhost:33418/callback"; // as Claude Code registers
  const client = await (
    await fetch(as.registration_endpoint, {
      body: JSON.stringify({
        client_name: "Claude",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [redirectUri],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  ).json();
  expect(client.client_id).toBeString();

  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(as.authorization_endpoint);
  for (const [key, value] of Object.entries({
    client_id: client.client_id,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    resource: LIFE,
    response_type: "code",
    scope: `${LIFE_SCOPE} offline_access`,
    state: "s1",
  })) {
    authorize.searchParams.set(key, value);
  }
  const toSignIn = await fetch(authorize, { redirect: "manual" });
  const signIn = new URL(toSignIn.headers.get("location") ?? "", base);
  expect(signIn.pathname).toBe("/sign-in");
  expect(await (await fetch(signIn)).text()).toContain("Sign in");

  const post = (path: string, json: object, session = "") =>
    fetch(`${base}${path}`, {
      body: JSON.stringify(json),
      headers: { "Content-Type": "application/json", cookie: session },
      method: "POST",
      redirect: "manual",
    });
  const wrong = await post("/api/auth/sign-in/email", {
    email: OWNER.email,
    oauth_query: signIn.search.slice(1),
    password: "wrong",
  });
  expect(wrong.ok).toBe(false);
  const signedIn = await post("/api/auth/sign-in/email", {
    ...OWNER,
    oauth_query: signIn.search.slice(1),
  });
  const cookie = (signedIn.headers.getSetCookie() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  const consent = new URL((await signedIn.json()).url, base);
  expect(consent.pathname).toBe("/consent");
  const consentText = await (await fetch(consent)).text();
  expect(consentText).toContain("Its sign-in code goes to <b>this Mac</b>.");
  expect(consentText).toContain(
    "change your Reminders, Atlas's tasks and your corrections to Life."
  );

  const accepted = await post(
    "/api/auth/oauth2/consent",
    { accept: true, oauth_query: consent.search.slice(1) },
    cookie
  );
  const back = new URL((await accepted.json()).url);
  expect(back.searchParams.get("state")).toBe("s1");

  const token = await (
    await fetch(as.token_endpoint, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code: back.searchParams.get("code") ?? "",
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        resource: LIFE,
      }),
      method: "POST",
    })
  ).json();
  expect(token.access_token).toBeString();
  return {
    access: token.access_token as string,
    clientId: client.client_id as string,
    refresh: token.refresh_token as string,
  };
}

// A JWT's payload, once its signature checks against the server's published keys, as Life checks it.
async function verified(token: string, jwksUrl: string) {
  const [head = "", body = "", signature = ""] = token.split(".");
  const decode = (part: string) =>
    JSON.parse(Buffer.from(part, "base64url").toString());
  const { keys } = await (await fetch(jwksUrl)).json();
  const jwk = keys.find((k: { kid: string }) => k.kid === decode(head).kid);
  const key = await crypto.subtle.importKey("jwk", jwk, "Ed25519", false, [
    "verify",
  ]);
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    Buffer.from(signature, "base64url"),
    Buffer.from(`${head}.${body}`)
  );
  expect(ok).toBe(true);
  return decode(body);
}

test("a client registered by DCR gets a token for Life, with Life as its audience", async () => {
  // Life's protected-resource metadata names this issuer; clients find the rest at its well-known.
  const as = await (
    await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)
  ).json();
  expect(as.issuer).toBe(`${base}/api/auth`);
  expect(as.jwks_uri).toBe(`${base}/api/auth/jwks`);
  const { access: token, clientId, refresh } = await connect(as);
  const claims = await verified(token, as.jwks_uri);
  expect(claims.aud).toBe(LIFE);
  expect(claims.iss).toBe(as.issuer);
  expect(claims.scope).toBe(`${LIFE_SCOPE} offline_access`);
  const [user] = env.db.all<{ id: string }>(sql`select id from auth_user`);
  expect(claims.sub).toBe(user?.id);
  // A refreshed token is Life's too.
  const refreshed = await (
    await fetch(as.token_endpoint, {
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refresh,
        resource: LIFE,
      }),
      method: "POST",
    })
  ).json();
  expect((await verified(refreshed.access_token, as.jwks_uri)).aud).toBe(LIFE);
  // Life's token opens none of lifelog's routes.
  const people = await fetch(`${base}/people`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(people.status).toBe(401);
}, 30_000);

test("a code never goes to a callback that isn't ChatGPT's, Claude's, Life's or this Mac's", async () => {
  // Registers `registered` (by default the callback it then asks for) and asks for a code.
  const authorize = async (redirect: string, registered = redirect) => {
    const client = await (
      await fetch(`${base}/api/auth/oauth2/register`, {
        body: JSON.stringify({
          client_name: "ChatGPT",
          redirect_uris: [registered],
          token_endpoint_auth_method: "none",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    ).json();
    const url = new URL(`${base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({
      client_id: client.client_id,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      redirect_uri: redirect,
      response_type: "code",
      scope: LIFE_SCOPE,
    })) {
      url.searchParams.set(key, value);
    }
    const to = (await fetch(url, { redirect: "manual" })).headers.get(
      "location"
    );
    return new URL(to ?? "", base);
  };
  const outcomes = await Promise.all(
    [
      "https://evil.example/callback",
      "https://chatgpt.com.evil.example/callback",
      "https://chatgpt.com/aip/g-stranger/oauth/callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://claude.ai/api/mcp/auth_callback",
      `${LIFE_URL}/check/callback`,
      // Another Life's: only the one at LIFE_URL is trusted.
      "https://life.stranger.example/check/callback",
    ].map(async (redirect) => {
      const to = await authorize(redirect);
      return to.searchParams.get("error") ?? to.pathname;
    })
  );
  // A trusted callback the client never registered gets nothing either.
  const unregistered = await authorize(
    "https://claude.ai/api/mcp/auth_callback",
    "https://evil.example/callback"
  );
  expect(unregistered.searchParams.get("error")).toBe("invalid_redirect");
  expect(outcomes).toEqual([
    "invalid_redirect",
    "invalid_redirect",
    "invalid_redirect",
    "/sign-in",
    "/sign-in",
    "/sign-in",
    "invalid_redirect",
  ]);
});

test("a LIFE_URL with a trailing slash keeps the audience and the callback clients already use", async () => {
  const other = testDb();
  const slashed = Bun.serve({ fetch: (req) => slashedApp.fetch(req), port: 0 });
  const at = `http://localhost:${slashed.port}`;
  const config = testConfig("http://localhost:1", {
    AUTH_SECRET: "x".repeat(32),
    LIFE_URL: `${LIFE_URL}/`,
    PUBLIC_BASE_URL: at,
  });
  const slashedApp = createApp(
    services(config, other.db, { intelligence: null, search: null })
  );
  try {
    const callback = `${LIFE_URL}/check/callback`;
    const client = await (
      await fetch(`${at}/api/auth/oauth2/register`, {
        body: JSON.stringify({
          client_name: "Life",
          redirect_uris: [callback],
          token_endpoint_auth_method: "none",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    ).json();
    const url = new URL(`${at}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({
      client_id: client.client_id,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      redirect_uri: callback,
      // The audience as tokens already carry it, without a double slash.
      resource: `${LIFE_URL}/mcp`,
      response_type: "code",
      scope: LIFE_SCOPE,
    })) {
      url.searchParams.set(key, value);
    }
    const to = (await fetch(url, { redirect: "manual" })).headers.get(
      "location"
    );
    expect(new URL(to ?? "", at).pathname).toBe("/sign-in");
  } finally {
    slashed.stop(true);
    other.drop();
  }
}, 30_000);

test("Life's sign-in is off without LIFE_URL", () => {
  const config = testConfig("http://localhost:1", {
    AUTH_SECRET: "x".repeat(32),
  });
  expect(authFor(authSettings(config), env.db)).toBeNull();
});
