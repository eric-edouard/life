import { expect, test } from "bun:test";
import type { Health } from "./health";
import {
  afterPoll,
  hearings,
  holdFor,
  type Pending,
  publicCheck,
} from "./watch";

const at = (m: number) => new Date(Date.UTC(2026, 9, 15, 10, m, 0));
const ok = (cursor: string) => ({ cursor });
const fail = { error: "lifelog GET /changes: 502" };

test("a successful poll resets the errors; an incident alerts once after 15 minutes and once when it ends", () => {
  let h: Health | null = null;
  const run = (minute: number, r: typeof fail | { cursor: string }) => {
    const next = afterPoll(h, at(minute), r, at(0));
    // What `notify` does once the mail is sent.
    const sent = { down: at(minute).toISOString(), up: null };
    h = {
      ...next.health,
      alertedAt: next.send ? sent[next.send] : next.health.alertedAt,
    };
    return next;
  };
  expect(run(0, ok("5")).send).toBeNull();
  expect(run(1, fail).health.consecutiveErrors).toBe(1);
  expect(run(10, fail).send).toBeNull();
  const down = run(16, fail);
  expect(down.send).toBe("down");
  expect(down.health.lagSec).toBe(16 * 60);
  expect(down.health.cursor).toBe("5");
  expect(run(20, fail).send).toBeNull();
  const up = run(25, ok("9"));
  expect(up.send).toBe("up");
  expect(up.health.consecutiveErrors).toBe(0);
  expect(up.health.lagSec).toBe(0);
  expect(run(26, ok("9")).send).toBeNull();
});

test("a watcher that never succeeded counts its downtime from its start", () => {
  const first = afterPoll(null, at(16), fail, at(0));
  expect(first.send).toBe("down");
  expect(first.health.lastOkAt).toBeNull();
});

test("the public check ignores an offline Mac, heals on the 2nd failure, alerts once on the 3rd, says back once", () => {
  let s = { checkedAt: null, failures: 0, result: null } as Parameters<
    typeof publicCheck
  >[0];
  const run = (online: boolean, up: boolean) => {
    const r = publicCheck(s, { ok: up, online });
    s = r.state;
    return r.action;
  };
  expect(run(false, false)).toBe("none");
  expect(s.failures).toBe(0);
  expect(run(true, false)).toBe("none");
  expect(run(false, false)).toBe("none");
  expect(run(true, false)).toBe("heal");
  expect(run(true, false)).toBe("alert");
  expect(run(true, false)).toBe("none");
  expect(run(true, true)).toBe("recovered");
  expect(run(true, true)).toBe("none");
  expect(run(true, false)).toBe("none");
  expect(run(true, true)).toBe("none");
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
  const old = { at: "2026-10-13T10:00:00.000Z", conversation: "d" };
  expect(heard([old], 0)).toEqual([]);
  expect(pending.size).toBe(0);
});
