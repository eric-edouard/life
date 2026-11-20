import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, HOUR, MIN } from "../core/clock";
import { queuedEvents } from "../host/desk-read";
import { paymentsChannelOf } from "../host/event-channels";
import type { Messaging } from "../host/events";
import type { Payment, PaymentsBackend } from "../payments/contract";
import type { EventFilter } from "../records/registered-agent";
import { openAssignment, register, setWait } from "./agent-actions";
import { readPeopleOnce, wakeDue } from "./desk-clock";
import { writeWait } from "./desk-store";
import { pollChannels } from "./event-queue";
import { advance, ahead, asgOf, chatSource, on, setup } from "./test-desk";

// An agent's wait on the payments channel: a made-up money app's payments wake it once, by amount or by words, and a
// wake hands their facts, never the merchant or the note.

const UNREAD = /payments could not be read since \S+: money tx: timed out/;

afterEach(() => {
  setSystemTime();
});

/** A payment paid now, out unless `eur` is positive. */
const payment = (over: Partial<Payment>): Payment => ({
  amount: -620,
  category: "travel",
  currency: "EUR",
  date: clock().toISOString().slice(0, 10),
  eur: -620,
  id: "t1",
  merchant: "Test Airline",
  note: "flight to Testville",
  paidAt: clock().toISOString(),
  spending: true,
  ...over,
});

/**
 * A desk whose money app holds `list` (off when `money.isOn` is false, failing with `money.why`), and an agent after
 * its first turn waiting on `filters`.
 */
async function waitingOn(...filters: Partial<EventFilter>[]) {
  const s = setup();
  const list: Payment[] = [];
  const money: { isOn: boolean; why: string } = { isOn: true, why: "" };
  const backend: PaymentsBackend = {
    between: (from, to) =>
      money.why
        ? Promise.reject(new Error(money.why))
        : Promise.resolve(list.filter((p) => p.date >= from && p.date <= to)),
  };
  s.desk.channels = [
    paymentsChannelOf(() => (money.isOn ? backend : undefined)),
  ];
  const id = register(s.desk, {
    brief: "Test brief: watch the trip's costs",
    folder: s.dir,
    runtime: "fake",
  });
  await wakeDue(s.desk);
  const rewait = (...events: Partial<EventFilter>[]) =>
    setWait(s.desk, on(s.desk, id), {
      events,
      reason: "a payment",
      until: ahead(HOUR),
    });
  const set = await rewait(...filters);
  await s.end(id);
  advance(MIN);
  const poll = async () => {
    advance(5 * MIN);
    await pollChannels(s.desk, readPeopleOnce());
  };
  const queued = () => queuedEvents(s.desk.db, asgOf(s.desk, id));
  return { ...s, id, list, money, poll, queued, rewait, set };
}

test("a wait on money out above 500 is woken once by 620 out, never by 40 out or 620 in", async () => {
  const { list, poll, queued, set } = await waitingOn({
    above: 500,
    channels: ["payments"],
    quantity: "eur_out",
  });
  expect(set).not.toHaveProperty("error");
  list.push(
    payment({}),
    payment({ amount: -40, eur: -40, id: "t2" }),
    payment({ amount: 620, eur: 620, id: "t3", spending: false })
  );
  await poll();
  await poll();
  expect(queued().map((e) => [e.name, e.event_id])).toEqual([
    ["payment.booked", "payments:t1"],
  ]);
});

test("a wait on money in matches money in whatever `spending` says; a pattern matches the merchant", async () => {
  const { list, poll, queued } = await waitingOn(
    { channels: ["payments"], quantity: "eur_in" },
    { channels: ["payments"], text_matches: "test airline" }
  );
  list.push(
    payment({
      amount: 80,
      eur: 80,
      id: "t1",
      merchant: "Test Refund",
      spending: true,
    }),
    payment({
      amount: 90,
      eur: 90,
      id: "t2",
      merchant: "Test Salary",
      spending: false,
    }),
    payment({ id: "t3" }),
    payment({ id: "t4", merchant: "Test Bakery" })
  );
  await poll();
  expect(queued().map((e) => e.event_id)).toEqual([
    "payments:t1",
    "payments:t2",
    "payments:t3",
  ]);
});

test("a filter with no channels is never woken by a payment", async () => {
  const { list, poll, queued } = await waitingOn(
    { channels: ["payments"], quantity: "eur_in" },
    { text_matches: "airline" }
  );
  list.push(payment({}));
  await poll();
  expect(queued()).toEqual([]);
});

test("a wake hands a payment's facts, never its merchant or note, with its local day", async () => {
  const { list, poll, queued } = await waitingOn({ channels: ["payments"] });
  // Africa/Lagos (UTC+1) in the test zones: 23:30 UTC is the next local day.
  list.push(payment({ date: "2026-11-18", paidAt: "2026-11-18T23:30:00Z" }));
  advance(15 * HOUR);
  await poll();
  const [row] = queued();
  const facts = JSON.parse(row?.payload ?? "{}");
  expect(Object.keys(facts).sort()).toEqual([
    "amount",
    "at",
    "category",
    "currency",
    "day",
    "eur_out",
    "id",
    "source",
    "spending",
  ]);
  expect([facts.day, facts.eur_out]).toEqual(["2026-11-19", 620]);
  expect(row?.payload).not.toContain("Test Airline");
  expect(row?.payload).not.toContain("Testville");
});

test("a payment with only its day wakes when it is not before the agent's day", async () => {
  const { list, poll, queued } = await waitingOn({ channels: ["payments"] });
  list.push(
    payment({ date: "2026-11-17", id: "t1", paidAt: null }),
    payment({ date: "2026-11-18", id: "t2", paidAt: null })
  );
  await poll();
  expect(queued().map((e) => e.event_id)).toEqual(["payments:t2"]);
});

test("a failing read queues nothing and the next wake says so", async () => {
  const { desk, fake, list, money, poll, queued } = await waitingOn({
    channels: ["payments"],
  });
  money.why = "money tx: timed out";
  list.push(payment({}));
  await poll();
  expect(queued()).toEqual([]);
  advance(HOUR);
  await wakeDue(desk);
  expect(fake.said.at(-1)?.message).toMatch(UNREAD);
});

test("a wait refuses payments off, an unknown or off channel, and keys its channels cannot answer", async () => {
  const { desk, money, rewait } = await waitingOn({ channels: ["payments"] });
  desk.sources = [{ ...chatSource([]), name: "phone" } as Messaging];
  const refusals = async (...filters: Partial<EventFilter>[]) =>
    (await Promise.all(filters.map((f) => rewait(f)))).map((r) =>
      "error" in r ? r.error : null
    );
  expect(
    await refusals(
      { channels: ["phone"] },
      { channels: ["whatsap"] },
      { channels: ["whatsapp"] },
      { quantity: "eur_out" },
      { above: 5, channels: ["payments"] },
      { channels: ["payments"], quantity: "kcal" },
      { channels: ["payments"], person: "Test Ana" }
    )
  ).toEqual([
    null,
    expect.stringContaining("whatsap is not a channel; channels:"),
    "whatsapp is off",
    "`quantity` needs `channels`",
    "`above` and `below` need a `quantity`",
    "no channel named holds kcal",
    expect.stringContaining("`person`, `chat` and `from_me` are a message's"),
  ]);
  money.isOn = false;
  expect(await refusals({ channels: ["payments"] })).toEqual([
    "payments are off in his settings",
  ]);
});

test("a payment the agent's own wait and its matter's both want wakes the matter's, once, poll after poll", async () => {
  const filter: EventFilter = {
    above: 500,
    channels: ["payments"],
    from_me: false,
    quantity: "eur_out",
  };
  const { desk, id, list, poll, queued } = await waitingOn(filter);
  const matter = openAssignment(desk, id, {
    openedBy: "owner",
    steps: ["obs_test_trip"],
  });
  writeWait(
    desk.db,
    matter,
    { events: [filter], reason: "r", until: ahead(HOUR) },
    false
  );
  advance(MIN);
  list.push(payment({}));
  await poll();
  await poll();
  expect(queued()).toEqual([]);
  expect(queuedEvents(desk.db, matter).map((e) => e.event_id)).toEqual([
    "payments:t1",
  ]);
});
