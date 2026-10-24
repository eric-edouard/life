import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { pair } from "./oauth";
import { signedIn } from "./server";

// The issuer as served opens /mcp: its keys and its owner are the ones the connector checks.
test("an app paired on the public port reads /mcp with the token it gets", async () => {
  const app = signedIn();
  const at = (path: string, init?: RequestInit) =>
    app.request(`https://life.example.test${path}`, init);
  const form = (fields: Record<string, string>) => ({
    body: new URLSearchParams(fields),
    method: "POST",
  });
  const callback = "https://claude.ai/api/mcp/auth_callback";
  const { client_id } = (await (
    await at("/auth/oauth2/register", {
      body: JSON.stringify({ redirect_uris: [callback] }),
      method: "POST",
    })
  ).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const resource = "https://life.example.test/mcp";
  const back = await at(
    "/auth/oauth2/authorize",
    form({
      client_id,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      pairing: pair(),
      redirect_uri: callback,
      resource,
      response_type: "code",
    })
  );
  const code = new URL(back.headers.get("location") ?? "").searchParams.get(
    "code"
  );
  const { access_token } = (await (
    await at(
      "/auth/oauth2/token",
      form({
        client_id,
        code: code ?? "",
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: callback,
      })
    )
  ).json()) as { access_token: string };
  const mcp = await at("/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${access_token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(mcp.status).toBe(200);
});

// The public port's app as served, its parts mounted in order: nothing of his before a sign-in, and no route but theirs.
test("the public port refuses the owner's pages without a session, serves Life's brand to anyone, and answers 404 for anything else", async () => {
  const app = signedIn();
  const get = (path: string, init?: RequestInit) =>
    app.request(`https://life.example.test${path}`, init);
  expect([200, 204]).not.toContain((await get("/check/statements")).status);
  expect((await get("/mcp")).status).toBe(401);
  expect((await get("/auth/oauth2/token")).status).toBe(404);
  expect((await get("/me/..%2Fetc")).status).toBe(404);
  const css = await get("/assets/brand/tokens.css");
  expect([css.status, (await css.text()).includes("--ink")]).toEqual([
    200,
    true,
  ]);
  expect((await get("/docs/brand.md")).status).toBe(200);
  expect((await get("/docs/agent.md")).status).toBe(404);
  const none = await get("/nope");
  expect([none.status, await none.text()]).toEqual([404, "not found"]);
});
