import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Health } from "./health";
import { hear } from "./hear";
import { ACTIONS } from "./memory/ledger";
import {
  turn as fed,
  lifelogServer,
  lifelogStore,
  page,
} from "./sources/fixtures";
import { apply } from "./sources/lifelog";
import { tasksOf } from "./tasks";
import { afterPoll, hearings, holdFor, type Pending, resumed } from "./watch";

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

test("a conversation is heard once its speech is complete: 5 s after his last turn arrived, 60 s while the next recording may go on; old speech is never heard", () => {
  const pending: Pending = new Map();
  const t = (s: number) => new Date(at(0).getTime() + s * 1000);
  const turn = (conversation: string, s: number) => ({
    at: t(s).toISOString(),
    conversation,
  });
  const speech = (conversation: string) =>
    conversation === "a" ? ("complete" as const) : ("open" as const);
  const heard = (turns: ReturnType<typeof turn>[], s: number) =>
    hearings(pending, turns, t(s).getTime(), speech);
  expect(heard([turn("a", 0), turn("c", 6)], 10)).toEqual([]);
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
  expect(holdFor(pending, t(40).getTime(), speech)).toBe(60);
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

test("a restart inside the wait hears again his and unattributed turns seen in the 10 minutes before the last poll: the ask is recorded once", async () => {
  const server = lifelogServer({
    "/transcription-jobs/job-1/transcript": () => ({
      turns: [
        { speakerId: null, text: "hey Atlas, call the bank" },
        { speakerId: null, text: "hey Atlas, buy me a car" },
        { speakerId: null, text: "nice weather" },
      ],
    }),
  });
  const store = lifelogStore();
  const said = "2026-10-19T10:00:00.000Z";
  const seen = Date.parse("2026-10-19T10:00:10.000Z");
  apply(
    store,
    page({
      turns: [
        fed(0, said, "p-me", "Me", "c1", true),
        fed(1, said, "p-ana", "Ana", "c2"),
        fed(2, said, null, null, "c3"),
      ],
    }),
    new Date(seen).toISOString()
  );
  const complete = () => "complete" as const;
  const iso = (ms: number) => new Date(ms).toISOString();
  /** A watcher started at `now` whose last poll was at `lastPoll`, run until nothing is pending. */
  const restart = async (lastPoll: number, now: number) => {
    const pending = resumed(store, iso(lastPoll), now);
    const keys = [...pending.keys()];
    for (const h of hearings(pending, [], now + 5000, complete)) {
      // biome-ignore lint/performance/noAwaitInLoops: one conversation at a time, as the watcher
      await hear(store, h.conversation, h.from, now + 5000);
    }
    return keys;
  };
  try {
    // The poll at `seen` brought the turns, then the watcher stopped inside the wait: its pending map is gone.
    expect(
      hearings(new Map(), [{ at: said, conversation: "c1" }], seen, complete)
    ).toEqual([]);
    expect(await restart(seen, seen + 30_000)).toEqual(["c1", "c3"]);
    // Restarted again after it heard them, its last poll 9 min after they were seen: heard again, recorded once.
    expect(await restart(seen + 9 * 60_000, seen + 9 * 60_000)).toEqual([
      "c1",
      "c3",
    ]);
    expect(tasksOf().map((t) => t.ask.instruction.quote)).toEqual([
      "hey Atlas, call the bank",
    ]);
    // Seen over 10 min before the last poll: long heard, never again.
    expect(await restart(seen + 11 * 60_000, seen + 11 * 60_000)).toEqual([]);
  } finally {
    server.close();
    rmSync(ACTIONS, { force: true });
  }
});
