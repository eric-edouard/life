import { expect, test } from "bun:test";
import { keyRefusal, localKey } from "./local-key";
import { createStatusReads } from "./status-reads";

// The app's status reads answer only with the local key, as a bearer.
const reads = createStatusReads(keyRefusal());
const get = (path: string, headers: Record<string, string> = {}) =>
  reads.request(new Request(`http://127.0.0.1:46201${path}`, { headers }));

test("the app's reads open with the local key only", async () => {
  const key = localKey();
  const as = (token: string) =>
    get("/status/card/mac", { authorization: `Bearer ${token}` });
  expect((await as(key))?.status).toBe(200);
  expect((await as(`${key.slice(1)}x`))?.status).toBe(401);
  // As many characters as the key, more bytes: refused, not a crash.
  expect((await as("é".repeat(key.length)))?.status).toBe(401);
  expect((await get("/status/card/mac"))?.status).toBe(401);
  // No page any more: nothing else is answered here.
  expect((await get("/")).status).toBe(404);
  // A card with no id is no card.
  const none = await get("/status/card", { authorization: `Bearer ${key}` });
  expect(none.status).toBe(404);
});

test("a history that doesn't page back offers no older page: the Mac's day is whole", async () => {
  const { detail } = await import("../status/snapshot-detail");
  expect((await detail("mac")).next.history).toBeNull();
});
