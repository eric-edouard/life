import { same, secretIn } from "../../core/secret";
import { text } from "./http";

// The local port's key: the app reads its status with it, on this Mac only (`server.ts`).

/** The key the app reads its status with on this Mac, kept in Life's state (mode 600), made on first use. */
export const localKey = () => secretIn("localKey");
const BEARER = /^Bearer /;

/**
 * The local port's gate: the key as a bearer, compared in constant time, else refused. Read once: a new key takes a
 * restart.
 */
export function keyRefusal(key = localKey()) {
  return (req: Request) => {
    const given = req.headers.get("authorization")?.replace(BEARER, "") ?? "";
    return Promise.resolve(same(given, key) ? null : text("local only", 401));
  };
}
