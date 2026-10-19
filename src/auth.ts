import { type JWTVerifyGetKey, jwtVerify } from "jose";

// The owner's sign-in, for the connector (/mcp, a Bearer token) and the check page (a cookie): lifelog's OAuth server
// issues the tokens for Life's resource; Life only checks them.

export const ORIGIN = "https://life.ericedouard.com";
export const RESOURCE = `${ORIGIN}/mcp`;
export const ISSUER = "https://lifelog.ericedouard.com/api/auth";
export const SCOPE = "life:read";
/** The check page's public client at lifelog (PKCE, no secret), registered once on 19 Oct for /check/callback. */
export const CHECK_CLIENT = "PycFqBLbqFmixRgErpQfyYLIGNsvHzoQ";

/**
 * Whose a token is: the owner's OAuth client and scopes when lifelog's OAuth server issued it for Life (`life:read`) to the owner, else why
 * not: `forbidden: …` when it is valid but someone else's or another scope, `invalid: …` otherwise. The one check behind /mcp and the check page.
 */
export function ownerTokens({
  jwks,
  now = Date.now,
  ownerSub,
}: {
  jwks: JWTVerifyGetKey;
  now?: () => number;
  ownerSub: string;
}) {
  return async (token: string) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        algorithms: ["EdDSA"],
        audience: RESOURCE,
        currentDate: new Date(now()),
        issuer: ISSUER,
      });
      const scopes = String(payload.scope ?? "").split(" ");
      if (payload.sub !== ownerSub) {
        return "forbidden: not the owner";
      }
      return scopes.includes(SCOPE)
        ? { clientId: String(payload.client_id), scopes }
        : `forbidden: no ${SCOPE}`;
    } catch (e) {
      return token ? `invalid: ${(e as Error).message}` : "invalid: no token";
    }
  };
}
export type Verify = ReturnType<typeof ownerTokens>;
