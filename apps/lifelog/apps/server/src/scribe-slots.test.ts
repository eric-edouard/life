import { expect, test } from "bun:test";
import { type Priority, scribeSlots } from "./scribe-slots";

const LONG = 60_000;
const go = () => null;

// A send that holds its slot until `free()`; `posted` once it holds it.
function holding(
  slots: ReturnType<typeof scribeSlots>,
  key: string,
  priority: Priority = "ordinary"
) {
  let free: () => void = () => undefined;
  let started: () => void = () => undefined;
  const posted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = slots.send(key, { priority, waitMs: LONG }, go, () => {
    started();
    return new Promise<void>((end) => {
      free = end;
    });
  });
  return { done, free: () => free(), posted };
}

test("dictation waits ahead of older waiters, each priority in arrival order; a send under way is never cut", async () => {
  const slots = scribeSlots(1, () => []);
  const first = holding(slots, "first");
  await first.posted;
  const order: string[] = [];
  const queued = (key: string, priority: Priority) =>
    slots.send(key, { priority, waitMs: LONG }, go, () => {
      order.push(key);
      return Promise.resolve();
    });
  const all = [
    queued("b", "ordinary"),
    queued("c", "ordinary"),
    queued("dictation", "interactive"),
    queued("dictation 2", "interactive"),
  ];
  await Bun.sleep(1);
  expect(order).toEqual([]);
  expect(slots.room()).toBe(0);
  first.free();
  await Promise.all(all);
  expect(order).toEqual(["dictation", "dictation 2", "b", "c"]);
  expect(slots.room()).toBe(1);
});

test("a wait ends at its bound or its abort; an abort, a refusal or a throw before the POST gives the slot back", async () => {
  const slots = scribeSlots(1, () => []);
  const posts: string[] = [];
  const post = (key: string) => () => {
    posts.push(key);
    return Promise.resolve();
  };
  const held = holding(slots, "held");
  await held.posted;
  expect(
    await slots.send(
      "late",
      { priority: "ordinary", waitMs: 5 },
      go,
      post("late")
    )
  ).toEqual({ unsent: "no Scribe slot came in time" });

  const waiting = new AbortController();
  const canceled = slots.send(
    "canceled",
    { priority: "interactive", signal: waiting.signal, waitMs: LONG },
    go,
    post("canceled")
  );
  waiting.abort();
  expect(await canceled).toEqual({ unsent: "canceled" });

  // Aborted after its slot was granted, before it could go.
  const granted = new AbortController();
  const late = slots.send(
    "granted",
    { priority: "interactive", signal: granted.signal, waitMs: LONG },
    go,
    post("granted")
  );
  held.free();
  // The held send resumes first and grants the slot; the abort lands before the waiter resumes.
  queueMicrotask(() => granted.abort());
  expect(await late).toEqual({ unsent: "canceled" });
  expect(slots.room()).toBe(1);

  const now = { priority: "ordinary" as const, waitMs: 0 };
  expect(
    await slots.send("refused", now, () => "moved", post("refused"))
  ).toEqual({
    unsent: "moved",
  });
  expect(
    slots.send(
      "claim throws",
      now,
      () => {
        throw new Error("claim");
      },
      post("claim throws")
    )
  ).rejects.toThrow("claim");
  await Bun.sleep(1);
  expect(
    slots.send("post throws", now, go, () => Promise.reject(new Error("post")))
  ).rejects.toThrow("post");
  await Bun.sleep(1);
  expect(posts).toEqual([]);
  expect(slots.room()).toBe(1);
});

test("a submitted job holds its slot until settled, its own send counted once; a freed slot goes to the line, else to the worker", async () => {
  let submitted = ["job-1"];
  let freed = 0;
  const slots = scribeSlots(
    2,
    () => submitted,
    () => {
      freed += 1;
    }
  );
  expect(slots.room()).toBe(1);
  // Its send under way and its row: one slot.
  const send = holding(slots, "job-1");
  await send.posted;
  expect(slots.room()).toBe(1);
  submitted = ["job-1", "job-2"];
  const dictation = holding(slots, "dictation", "interactive");
  send.free();
  await send.done;
  expect(slots.room()).toBe(0);
  expect(freed).toBe(0);
  // Its webhook came: a wake grants the slot.
  submitted = ["job-2"];
  slots.wake();
  await dictation.posted;
  expect(slots.room()).toBe(0);
  dictation.free();
  await dictation.done;
  expect(freed).toBe(1);
  expect(slots.room()).toBe(1);
});
