import { createHmac } from "node:crypto";
import { secretIn } from "../core/secret";
import { DOOR_PORT } from "../host/http/http";

// Each registered agent's door: its address and its key, `HMAC(deskKey, its id)`, derived, never stored. Apart from the
// door's server (`desk-door.ts`), which checks it, so what starts a session (`turn-ends.ts`) needs no server.

/** The key of agent `id`'s door. */
export const keyOf = (id: string) =>
  createHmac("sha256", secretIn("deskKey")).update(id).digest("hex");

/** Where agent `id`'s session reaches its door, and the key it shows there. */
export const doorOf = (id: string) => ({
  key: keyOf(id),
  url: `http://127.0.0.1:${DOOR_PORT}/mcp/${id}`,
});
