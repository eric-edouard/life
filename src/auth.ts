import { errors, type JWTVerifyGetKey, jwtVerify } from "jose";

// The owner's sign-in, for the connector (/mcp, a Bearer token) and the check page (a cookie): an OAuth server (the
// `connector` setting's issuer) issues the tokens for Life's resource; Life only checks them.

export const SCOPE = "life:read";

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
      return refused(
        unreachable ? "unreachable" : "invalid",
        (e as Error).message
      );
    }
  };
}
export type Verify = ReturnType<typeof ownerTokens>;
