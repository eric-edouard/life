import { errors, type JWTVerifyGetKey, jwtVerify } from "jose";

// The owner's sign-in, for the connector (/mcp, a Bearer token) and the check page (a cookie): lifelog's OAuth server
// issues the tokens for Life's resource; Life only checks them.

export const ORIGIN = "https://life.ericedouard.com";
export const RESOURCE = `${ORIGIN}/mcp`;
/** The resource's OAuth metadata; also the tunnel's health probe (src/tunnel.ts). */
export const METADATA = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
export const ISSUER = "https://lifelog.ericedouard.com/api/auth";
export const SCOPE = "life:read";
/** The check page's public client at lifelog (PKCE, no secret), registered once on 19 Oct for /check/callback. */
export const CHECK_CLIENT = "PycFqBLbqFmixRgErpQfyYLIGNsvHzoQ";

const refused = (
  refusal: "forbidden" | "invalid" | "unreachable",
  why: string
) => ({
  refusal,
  why,
});
export type Refused = ReturnType<typeof refused>;
/** What an `unreachable` refusal answers, with a 503: Life is up, lifelog's keys are not. */
export const UNREACHABLE = "lifelog unreachable, try again";

/**
 * Whose a token is: the owner's OAuth client and scopes when lifelog's OAuth server issued it for Life (`life:read`) to the owner, else a
 * `refusal` and `why`: `forbidden` when it is valid but someone else's or another scope, `unreachable` when lifelog's keys
 * could not be fetched (the token was not judged), `invalid` otherwise. The one check behind /mcp and the check page.
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
    // Only a key set that has no key for this token is the token's fault; any other failure to get keys is lifelog's.
    let unreachable = false;
    const keys: JWTVerifyGetKey = async (header, jws) => {
      try {
        return await jwks(header, jws);
      } catch (e) {
        unreachable = !(
          e instanceof errors.JWKSNoMatchingKey ||
          e instanceof errors.JWKSMultipleMatchingKeys
        );
        throw e;
      }
    };
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ["EdDSA"],
        audience: RESOURCE,
        currentDate: new Date(now()),
        issuer: ISSUER,
      });
      const scopes = String(payload.scope ?? "").split(" ");
      if (payload.sub !== ownerSub || !scopes.includes(SCOPE)) {
        const why = payload.sub === ownerSub ? `no ${SCOPE}` : "not the owner";
        return refused("forbidden", why);
      }
      return { clientId: String(payload.client_id), scopes };
    } catch (e) {
      return refused(
        unreachable ? "unreachable" : "invalid",
        (e as Error).message
      );
    }
  };
}
export type Verify = ReturnType<typeof ownerTokens>;
