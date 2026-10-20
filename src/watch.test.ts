import { expect, test } from "bun:test";
import type { Health } from "./health";
import { afterPoll, hearings, holdFor, type Pending } from "./watch";

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

test("a conversation is heard once its speech is complete: 5 s after his last turn arrived, 40 s while a turn has no speaker, 60 s while the next recording may go on; old speech is never heard", () => {
  const pending: Pending = new Map();
  const t = (s: number) => new Date(at(0).getTime() + s * 1000);
  const turn = (conversation: string, s: number) => ({
    at: t(s).toISOString(),
    conversation,
  });
  const speech = (conversation: string) =>
    (({ a: "complete", b: "unnamed" }) as const)[conversation] ?? "open";
  const heard = (turns: ReturnType<typeof turn>[], s: number) =>
    hearings(pending, turns, t(s).getTime(), speech);
  expect(heard([turn("a", 0), turn("b", 5), turn("c", 6)], 10)).toEqual([]);
  expect(holdFor(pending, t(10).getTime(), speech)).toBe(5);
  // Rounded up, and never less than a second.
  expect(holdFor(pending, t(11.8).getTime(), speech)).toBe(4);
  expect(holdFor(pending, t(20).getTime(), speech)).toBe(1);
  expect(heard([], 14)).toEqual([]);
  expect(heard([], 15)).toEqual([
    { conversation: "a", from: t(0).toISOString(), tries: 0 },
  ]);
  // A turn of "c" arrived at 40 s: its wait restarted.
  expect(heard([turn("c", 30)], 40)).toEqual([]);
  expect(heard([], 49)).toEqual([]);
  expect(heard([], 50)).toEqual([
    { conversation: "b", from: t(5).toISOString(), tries: 0 },
  ]);
  expect(holdFor(pending, t(50).getTime(), speech)).toBe(50);
  expect(heard([], 99)).toEqual([]);
  expect(heard([], 100)).toEqual([
    { conversation: "c", from: t(6).toISOString(), tries: 0 },
  ]);
  expect(holdFor(pending, t(100).getTime(), speech)).toBe(60);
  const old = { at: "2026-10-08T09:59:00.000Z", conversation: "d" };
  expect(heard([old], 0)).toEqual([]);
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
  const open = () => "open" as const;
  expect(hearings(pending, turns, back, open)).toEqual([]);
  expect(hearings(pending, [], back + 60_000, open)).toEqual([
    { conversation: "d", from: said, tries: 0 },
  ]);
  expect(hearings(pending, [], back + 120_000, open)).toEqual([]);
});
