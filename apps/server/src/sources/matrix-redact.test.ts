import { afterEach, expect, spyOn, test } from "bun:test";
import { deleteLineOf, redact } from "./matrix-redact";

// A made-up room and event.

const NOW = new Date("2026-11-18T09:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

let fetched: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetched?.mockRestore());

test("a delete is offered only where the room's own features allow it, and only inside its window", () => {
  expect(deleteLineOf(undefined, ago(5), NOW)).toBeUndefined();
  expect(deleteLineOf({ reply: 1 }, ago(5), NOW)).toBeUndefined();
  expect(deleteLineOf({ delete: 0 }, ago(5), NOW)).toBeUndefined();
  expect(deleteLineOf({ delete: 1 }, ago(86_400 * 30), NOW)).toContain(
    "deleted for both"
  );
  const windowed = { delete: 2, delete_max_age: 3600 };
  expect(deleteLineOf(windowed, ago(3599), NOW)).toContain("deleted");
  expect(deleteLineOf(windowed, ago(3601), NOW)).toBeUndefined();
});

test("a redaction is put as him, and reported deleted only once the bridge's record of it is gone", async () => {
  const calls: string[] = [];
  fetched = spyOn(globalThis, "fetch").mockImplementation(((url: string) => {
    calls.push(url);
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as never);
  const at = { confirmMs: 1000, homeserver: "http://hs.test", token: "t" };
  let checks = 0;
  await redact("!room", "$event", at, () => {
    checks += 1;
    return checks > 1;
  });
  expect(calls).toEqual([
    "http://hs.test/_matrix/client/v3/rooms/!room/redact/%24event/undo-%24event",
  ]);
  await expect(redact("!room", "$event", at, () => false)).rejects.toThrow(
    "may not be deleted"
  );
  await expect(redact(undefined, "$event", at, () => true)).rejects.toThrow(
    "not deleted"
  );
});
