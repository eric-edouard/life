import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { ownerTokens } from "./auth";
import { createIssuer, pair } from "./oauth";

const ORIGIN = "https://life.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const DOC = "https://claude.ai/oauth/life-client.json";
/** A desktop app's document: a loopback return address without a port. */
const DESKTOP_DOC = "https://claude.ai/oauth/desktop-client.json";

const life = createIssuer(ORIGIN, RESOURCE, {
  fetchDoc: (async (url: URL) =>
    String(url) === DOC || String(url) === DESKTOP_DOC
      ? Response.json({
          client_id: String(url),
          client_name: "Claude",
          redirect_uris: [
            String(url) === DOC ? CALLBACK : "http://localhost/callback",
          ],
        })
      : new Response("no", { status: 404 })) as typeof fetch,
});
const call = async (path: string, init?: RequestInit) =>
  (await life.app.request(new Request(`${ORIGIN}${path}`, init))) as Response;
const form = (fields: Record<string, string>) => ({
  body: new URLSearchParams(fields),
  method: "POST",
});
const verify = ownerTokens({
  issuer: life.issuer,
  jwks: life.jwks,
  ownerSub: life.owner,
  resource: RESOURCE,
});

/** An app's whole sign-in: authorize with the pairing code, then trade the code for tokens. */
async function signIn(client: string, pairing: string, redirect = CALLBACK) {
  const verifier = randomBytes(32).toString("base64url");
  const ask = {
    client_id: client,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    redirect_uri: redirect,
    resource: RESOURCE,
    response_type: "code",
    state: "s1",
  };
  const back = await call("/auth/oauth2/authorize", form({ ...ask, pairing }));
  if (back.status !== 302) {
    return { page: await back.text() };
  }
  const url = new URL(back.headers.get("location") ?? "");
  expect(url.searchParams.get("state")).toBe("s1");
  expect(url.searchParams.get("iss")).toBe(life.issuer);
  const res = await call(
    "/auth/oauth2/token",
    form({
      client_id: client,
      code: url.searchParams.get("code") ?? "",
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirect,
      resource: RESOURCE,
    })
  );
  return (await res.json()) as {
    access_token: string;
    refresh_token: string;
  };
}

test("an app connects only with the pairing code, and gets the owner's tokens for this resource", async () => {
  const meta = (await (
    await call("/.well-known/oauth-authorization-server/auth")
  ).json()) as { code_challenge_methods_supported: string[]; issuer: string };
  expect(meta.issuer).toBe(`${ORIGIN}/auth`);
  expect(meta.code_challenge_methods_supported).toEqual(["S256"]);

  const reg = await call("/auth/oauth2/register", {
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [CALLBACK] }),
    method: "POST",
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  expect(reg.status).toBe(201);

  pair();
  expect(await signIn(client_id, "WRONG1")).toHaveProperty("page");
  const tokens = (await signIn(client_id, pair())) as {
    access_token: string;
    refresh_token: string;
  };
  expect(await verify(tokens.access_token)).toMatchObject({
    clientId: client_id,
  });

  // A refresh token serves once: the second use is refused.
  const refresh = (token: string) =>
    call(
      "/auth/oauth2/token",
      form({ client_id, grant_type: "refresh_token", refresh_token: token })
    );
  expect((await refresh(tokens.refresh_token)).status).toBe(200);
  expect((await refresh(tokens.refresh_token)).status).toBe(400);
});

test("a pairing code is spent once, and a few wrong tries end it", async () => {
  const code = pair();
  for (const wrong of ["AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD", "EEEEEE"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one try at a time
    expect(await signIn(DOC, wrong)).toHaveProperty("page");
  }
  expect(await signIn(DOC, code)).toHaveProperty("page");
});

test("an app names itself by its document on Claude's or ChatGPT's hosts, and no other return address is taken", async () => {
  expect(await signIn(DOC, pair())).toHaveProperty("access_token");
  const reg = await call("/auth/oauth2/register", {
    body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
    method: "POST",
  });
  expect(reg.status).toBe(400);
  expect(
    await signIn("https://evil.example/client.json", pair())
  ).toHaveProperty("page");
});

test("a desktop app's loopback return address takes any port, and only on the loopback", async () => {
  const at = (uri: string) => signIn(DESKTOP_DOC, pair(), uri);
  expect(await at("http://localhost:53124/callback")).toHaveProperty(
    "access_token"
  );
  expect(await at("http://localhost:53124/elsewhere")).toHaveProperty("page");
  expect(await signIn(DOC, pair(), `${CALLBACK}:8443`)).toHaveProperty("page");

  // The code is for the port it was asked on: the trade on another port is refused.
  const verifier = randomBytes(32).toString("base64url");
  const back = await call(
    "/auth/oauth2/authorize",
    form({
      client_id: DESKTOP_DOC,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      pairing: pair(),
      redirect_uri: "http://localhost:53124/callback",
      resource: RESOURCE,
      response_type: "code",
    })
  );
  const trade = await call(
    "/auth/oauth2/token",
    form({
      client_id: DESKTOP_DOC,
      code:
        new URL(back.headers.get("location") ?? "").searchParams.get("code") ??
        "",
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "http://localhost:53125/callback",
    })
  );
  expect(trade.status).toBe(400);
});

test("a code serves once and only with its verifier; an unpaired registration is not kept", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const ask = {
    client_id: DOC,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    redirect_uri: CALLBACK,
    resource: RESOURCE,
    response_type: "code",
  };
  const back = await call(
    "/auth/oauth2/authorize",
    form({ ...ask, pairing: pair() })
  );
  const code = new URL(back.headers.get("location") ?? "").searchParams.get(
    "code"
  );
  const trade = (v: string) =>
    call(
      "/auth/oauth2/token",
      form({
        client_id: DOC,
        code: code ?? "",
        code_verifier: v,
        grant_type: "authorization_code",
        redirect_uri: CALLBACK,
      })
    );
  expect((await trade("not-the-verifier")).status).toBe(400);
  // The wrong try spent it: the right verifier comes too late.
  expect((await trade(verifier)).status).toBe(400);

  // Twenty-one registrations: the first is gone before anyone paired it.
  const ids: string[] = [];
  for (let i = 0; i < 21; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: in order
    const reg = await call("/auth/oauth2/register", {
      body: JSON.stringify({ redirect_uris: [CALLBACK] }),
      method: "POST",
    });
    ids.push(((await reg.json()) as { client_id: string }).client_id);
  }
  expect(await signIn(ids[0] ?? "", pair())).toHaveProperty("page");
  expect(await signIn(ids[20] ?? "", pair())).toHaveProperty("access_token");
});
