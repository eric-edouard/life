import { expect, test } from "bun:test";
import type { Payment } from "../payments/contract";
import type { Episode } from "../records/episode";
import type { Stay } from "../sources/lifelog";
import { paid, paymentLine, place } from "./payments";
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
