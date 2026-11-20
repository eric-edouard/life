import { expect, test } from "bun:test";
import { type Release, scribeSlots } from "./scribe-slots";

const LONG = 60_000;

test("dictation waits ahead of older waiters, each priority in arrival order; a send under way is never cut", async () => {
  const slots = scribeSlots(1, () => []);
  const first = await slots.wait("a", { priority: "ordinary", waitMs: 0 });
  expect(first).not.toBeNull();
  const order: string[] = [];
  const queued = (key: string, priority: "interactive" | "ordinary") =>
    slots.wait(key, { priority, waitMs: LONG }).then((release) => {
      order.push(key);
      return release as Release;
    });
  const b = queued("b", "ordinary");
  const c = queued("c", "ordinary");
  const d = queued("dictation", "interactive");
  const e = queued("dictation 2", "interactive");
  await Bun.sleep(1);
  expect(order).toEqual([]);
  expect(slots.room()).toBe(0);
  first?.();
  for (const next of [d, e, b, c]) {
    // biome-ignore lint/performance/noAwaitInLoops: one slot passes on at a time
    (await next)();
  }
  expect(order).toEqual(["dictation", "dictation 2", "b", "c"]);
  expect(slots.room()).toBe(1);
});

test("a wait ends at its bound or its abort, and the slot goes to the next in line", async () => {
  const slots = scribeSlots(1, () => []);
  const held = (await slots.wait("a", {
    priority: "ordinary",
    waitMs: 0,
  })) as Release;
  expect(await slots.wait("late", { priority: "ordinary", waitMs: 5 })).toBe(
    null
  );
  const abort = new AbortController();
  const canceled = slots.wait("canceled", {
    priority: "interactive",
    signal: abort.signal,
    waitMs: LONG,
  });
  const next = slots.wait("next", { priority: "ordinary", waitMs: LONG });
  abort.abort();
  expect(await canceled).toBeNull();
  held();
  held(); // a second release frees nothing more
  expect(await next).not.toBeNull();
  expect(slots.room()).toBe(0);
  const aborted = new AbortController();
  aborted.abort();
  expect(
    await slots.wait("x", {
      priority: "interactive",
      signal: aborted.signal,
      waitMs: LONG,
    })
  ).toBeNull();
});

test("a submitted job holds its slot until it is settled, its own send counted once; the line waits for wake", async () => {
  let submitted = ["job-1"];
  const slots = scribeSlots(2, () => submitted);
  expect(slots.room()).toBe(1);
  // Its send under way and its row: one slot.
  const send = (await slots.wait("job-1", {
    priority: "ordinary",
    waitMs: 0,
  })) as Release;
  expect(slots.room()).toBe(1);
  submitted = ["job-1", "job-2"];
  const dictation = slots.wait("dictation", {
    priority: "interactive",
    waitMs: LONG,
  });
  send();
  expect(slots.room()).toBe(0);
  // Its webhook came: the next wake grants the slot.
  submitted = ["job-2"];
  slots.wake();
  expect(await dictation).not.toBeNull();
  expect(slots.room()).toBe(0);
});
