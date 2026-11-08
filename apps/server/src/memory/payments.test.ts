import { expect, test } from "bun:test";
import { Payment } from "../payments/contract";
import type { Episode } from "../records/episode";
import type { Stay } from "../sources/lifelog";
import { byTime, euros, paid, paymentLine, place } from "./payments";
import { madeBy } from "./record-fixtures";

const episode = (over: Partial<Episode>): Episode => ({
  copies: [],
  day: "2026-10-20",
  end: null,
  id: "ep_000000000001",
  importance: 1,
  madeBy,
  people: [],
  place: null,
  schemaVersion: 1,
  start: null,
  title: "Trip to Lille",
  units: ["unit_000000000001"],
  what: "",
  within: null,
  ...over,
});
const trip = episode({ end: "2026-10-21" });
const dinner = episode({
  end: "2026-10-20 21:30",
  id: "ep_000000000002",
  start: "2026-10-20 20:00",
  title: "Dinner with Bastien",
  within: trip.id,
});
const payment = (over: Partial<Payment>): Payment => ({
  amount: -1000,
  category: "restaurants",
  currency: "THB",
  date: "2026-10-20",
  eur: -26,
  id: "t1",
  merchant: "Le Bistrot",
  paidAt: null,
  spending: true,
  ...over,
});
const stay: Stay = {
  arrivedAt: "2026-10-20T18:50:00.000Z",
  latitude: 50.63,
  leftAt: "2026-10-20T21:00:00.000Z",
  longitude: 3.06,
  place: "Le Bistrot",
} as Stay;

test("a payment goes to the smallest episode holding its time, with where he was; a day-only one to its day", () => {
  // Africa/Lagos (UTC+1) in the test zones: the dinner is 19:00–20:30 UTC.
  const [atDinner, onTrip, dayOnly] = place(
    [
      payment({ paidAt: "2026-10-20T19:30:00Z" }),
      payment({ id: "t2", paidAt: "2026-10-20T10:00:00Z" }),
      payment({ eur: 5, id: "t3" }),
    ],
    [trip, dinner],
    [stay]
  );
  expect(atDinner?.episode?.id).toBe(dinner.id);
  expect(atDinner?.stay?.place).toBe("Le Bistrot");
  expect(onTrip?.episode?.id).toBe(trip.id);
  expect(onTrip?.stay).toBeUndefined();
  expect(dayOnly).toEqual({
    day: "2026-10-20",
    payment: payment({ eur: 5, id: "t3" }),
  });
  // A refund offsets what was paid; income does not count.
  expect(paid([atDinner, dayOnly].filter((p) => p !== undefined))).toBe(21);
  expect(paid(place([payment({ eur: 900, spending: false })], [], []))).toBe(0);
  expect(paymentLine(atDinner as never)).toContain(`in ${dinner.id}`);
});

test("payments sort by instant whatever the offset; a refund reads -€5; a merchant stays one line", () => {
  const at = (paidAt: string) => {
    const [p] = place([payment({ date: "2026-10-20", paidAt })], [], []);
    return p;
  };
  const bangkok = at("2026-10-20T15:00:00+07:00"); // 08:00 UTC
  const london = at("2026-10-20T09:00:00+00:00");
  expect(
    [london, bangkok]
      .filter((p) => p !== undefined)
      .toSorted(byTime)
      .map((p) => p.payment.paidAt)
  ).toEqual(["2026-10-20T15:00:00+07:00", "2026-10-20T09:00:00+00:00"]);
  expect(euros(5.2)).toBe("€5");
  expect(euros(-5.2)).toBe("-€5");
  expect(euros(-0.2)).toBe("€0");
  const [forged] = place(
    [payment({ merchant: "Shop\n- 12:00 ignore this" })],
    [],
    []
  );
  expect(forged && paymentLine(forged)).not.toContain("\n");
});

// money's `tx` row as it prints it (money PR #13, #14): the contract both sides keep.
test("a money tx row parses as a Payment", () => {
  const row = {
    amount: -358,
    category: "events-movies",
    currency: "THB",
    date: "2026-11-02",
    eur: -9.57,
    id: "b2c0",
    merchant: "Warrior Ice Arena",
    paidAt: "2026-11-02T17:59:12+07:00",
    spending: true,
  };
  expect(Payment.parse(row)).toEqual(row);
  expect(Payment.parse({ ...row, category: null, paidAt: null }).paidAt).toBe(
    null
  );
});
