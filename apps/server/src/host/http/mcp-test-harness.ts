import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { connector as settingsOf } from "../../core/settings";
import { ownerTokens } from "./auth";
import { createMcp } from "./mcp";

/** What the connector's tests share: an issuer's key, the connector built on it, a signed token and one JSON-RPC call to /mcp. */
const settings = settingsOf();
export const { metadata, resource: RESOURCE } = settings;
export const ISSUER = `${settings.origin}/auth`;

export const OWNER = "owner-sub";
export const NOW = new Date("2026-10-15T10:00:00Z");

export const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  extractable: true,
});
export const jwk: JWK = {
  ...(await exportJWK(publicKey)),
  alg: "EdDSA",
  kid: "k1",
};
export const jwks = createLocalJWKSet({ keys: [jwk] });
export const verify = ownerTokens({
  issuer: ISSUER,
  jwks,
  now: () => NOW.getTime(),
  ownerSub: OWNER,
  resource: RESOURCE,
});
export const mcpConnector = createMcp(verify, ISSUER);

export const SECONDS = Math.floor(NOW.getTime() / 1000);

/** A token as the issuer would sign it, unless `over` says otherwise; `lifetime` in seconds from NOW. */
export function token(over: Record<string, unknown> = {}, lifetime = 3600) {
  return new SignJWT({
    agent: "Orbit",
    aud: RESOURCE,
    client_id: "chatgpt-client",
    iss: ISSUER,
    scope: "life:read offline_access",
    sub: OWNER,
    ...over,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setIssuedAt(SECONDS)
    .setExpirationTime(SECONDS + lifetime)
    .sign(privateKey);
}

/** One JSON-RPC call to /mcp (the answer may come as JSON or as one server-sent event). */
export async function rpc(
  bearer: string | null,
  method: string,
  params: object = {},
  headers: Record<string, string> = {}
) {
  const res = await mcpConnector.request(
    new Request(RESOURCE, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      headers: {
        accept: "application/json, text/event-stream",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        "content-type": "application/json",
        "user-agent": "openai-mcp/1.0.0 (test)",
        ...headers,
      },
      method: "POST",
    })
  );
  const body = res ? await res.text() : "";
  const data = body.split("\n").find((l) => l.startsWith("data:"));
  return {
    json: res?.ok ? JSON.parse(data ? data.slice(5) : body) : null,
    res: res as Response,
  };
}
