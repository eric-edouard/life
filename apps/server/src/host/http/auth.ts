import { type JWTVerifyGetKey, jwtVerify } from "jose";

// The owner's sign-in, for the connector (/mcp, a Bearer token) and the check page (a cookie): Life's own issuer
// (`oauth.ts`) issues the tokens for Life's resource; this checks them.

export const SCOPE = "life:read";

const refused = (refusal: "forbidden" | "invalid", why: string) => ({
  refusal,
  why,
});
export type Refused = ReturnType<typeof refused>;

/**
 * Whose a token is: the owner's OAuth client and scopes when the issuer signed it for Life (`life:read`) to the owner,
 * else a `refusal` and `why`: `forbidden` when it is valid but someone else's or another scope, `invalid` otherwise.
 * The one check behind /mcp and the check page.
 */
export function ownerTokens({
  issuer,
  jwks,
  now = Date.now,
  ownerSub,
  resource,
}: {
  issuer: string;
  jwks: JWTVerifyGetKey;
  now?: () => number;
  ownerSub: string;
  resource: string;
}) {
  return async (token: string) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        algorithms: ["EdDSA"],
        audience: resource,
        currentDate: new Date(now()),
        issuer,
      });
      const scopes = String(payload.scope ?? "").split(" ");
      if (payload.sub !== ownerSub || !scopes.includes(SCOPE)) {
        const why = payload.sub === ownerSub ? `no ${SCOPE}` : "not the owner";
        return refused("forbidden", why);
      }
      return { clientId: String(payload.client_id), scopes };
    } catch (e) {
      return refused("invalid", (e as Error).message);
    }
  };
}
export type Verify = ReturnType<typeof ownerTokens>;
