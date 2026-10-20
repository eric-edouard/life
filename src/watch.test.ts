import { expect, test } from "bun:test";
import type { Health } from "./health";
import { afterPoll, hearings, type Pending } from "./watch";

const at = (m: number) => new Date(Date.UTC(2026, 9, 15, 10, m, 0));
const ok = (cursor: string) => ({ cursor });
const fail = { error: "lifelog GET /changes: 502" };

test("a successful poll resets the errors and the lag; a failed one keeps the last cursor", () => {
  let h: Health | null = null;
  const run = (minute: number, r: typeof fail | { cursor: string }) => {
    h = afterPoll(h, at(minute), r, at(0));
    return h;
  };
  expect(run(0, ok("5")).consecutiveErrors).toBe(0);
  expect(run(1, fail).consecutiveErrors).toBe(1);
  const down = run(16, fail);
  expect(down.consecutiveErrors).toBe(2);
  expect(down.lagSec).toBe(16 * 60);
  expect(down.cursor).toBe("5");
  const up = run(25, ok("9"));
  expect(up.consecutiveErrors).toBe(0);
  expect(up.lagSec).toBe(0);
  expect(up.lastError).toBeNull();
});

test("a watcher that never succeeded counts its lag from its start", () => {
  const first = afterPoll(null, at(16), fail, at(0));
  expect(first.lagSec).toBe(16 * 60);
  expect(first.lastOkAt).toBeNull();
});

test("a conversation is heard once, 40 s after his last turn arrived, from his earliest turn; old speech is never heard", () => {
  const pending: Pending = new Map();
  const t = (s: number) => new Date(at(0).getTime() + s * 1000);
  const turn = (conversation: string, s: number) => ({
    at: t(s).toISOString(),
    conversation,
  });
  expect(
    hearings(pending, [turn("a", 0), turn("b", 5)], t(10).getTime())
  ).toEqual([]);
  expect(hearings(pending, [], t(49).getTime())).toEqual([]);
  expect(hearings(pending, [turn("a", 45)], t(50).getTime())).toEqual([
    { conversation: "b", from: t(5).toISOString(), tries: 0 },
  ]);
  // A turn of "a" arrived at 50 s: its quiet restarted.
  expect(hearings(pending, [], t(89).getTime())).toEqual([]);
  expect(hearings(pending, [], t(90).getTime())).toEqual([
    { conversation: "a", from: t(0).toISOString(), tries: 0 },
  ]);
  expect(hearings(pending, [], t(999).getTime())).toEqual([]);
  const old = { at: "2026-10-08T09:59:00.000Z", conversation: "c" };
  expect(hearings(pending, [old], t(0).getTime())).toEqual([]);
  expect(pending.size).toBe(0);
});

test("after a 3-day outage, his turns from before it are still heard, once, from his first turn", () => {
  const pending: Pending = new Map();
  const back = at(0).getTime();
  const said = "2026-10-12T10:00:00.000Z";
  const turns = [
    { at: said, conversation: "d" },
    { at: "2026-10-12T10:00:05.000Z", conversation: "d" },
  ];
  expect(hearings(pending, turns, back)).toEqual([]);
  expect(hearings(pending, [], back + 40_000)).toEqual([
    { conversation: "d", from: said, tries: 0 },
  ]);
  expect(hearings(pending, [], back + 80_000)).toEqual([]);
});
