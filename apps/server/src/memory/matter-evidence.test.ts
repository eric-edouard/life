import { expect, test } from "bun:test";
import type { Payment } from "../payments/contract";
import {
  EVIDENCE_DAYS,
  paymentsFor,
  windowOf,
  withoutOwnerOf,
} from "./matter-evidence";

const paid = (day: string, merchant: string, note: string | null = null) => ({
  day,
  payment: {
    amount: -690,
    category: "home-goods",
    currency: "THB",
    date: day,
    eur: 18,
    id: `p-${day}-${merchant}`,
    merchant,
    note,
    paidAt: null,
    spending: true,
  } satisfies Payment,
});

test("a matter's window runs from its oldest open step's day, at most EVIDENCE_DAYS back; none without an open step", () => {
  const open = (day: string) => ({ day }) as never;
  expect(
    windowOf(
      { openSteps: [open("2026-11-07"), open("2026-11-05")] },
      "2026-11-21"
    )
  ).toEqual({
    from: "2026-11-05",
    to: "2026-11-21",
  });
  expect(
    windowOf({ openSteps: [open("2025-01-01")] }, "2026-11-21")?.from
  ).toBe("2026-07-24");
  expect(EVIDENCE_DAYS).toBe(120);
  expect(windowOf({ openSteps: [] }, "2026-11-21")).toBeNull();
});

test("a matter's payments: in its window, sharing a word of its name (3 letters or more, not in more than 1% of the payments read), the most shared first, each with its call's id", () => {
  const list = [
    paid("2026-11-07", "Fixit Co", "Installing the condo water heater"),
    paid("2026-11-08", "Corner Cafe"),
    paid("2026-11-01", "Heater Shop", "heater"),
    paid("2026-11-09", "Heater Outlet"),
    paid("2026-11-10", "Water Board"),
  ];
  const found = paymentsFor(
    "Install the new water heater in the condo",
    { from: "2026-11-05", to: "2026-11-21" },
    list,
    (n) => `pay-${n + 1}`
  );
  // "heater" is in 3 of 5 payments: it ties nothing; "condo" and "water" do.
  expect(found.map((p) => [p.id, p.day])).toEqual([
    ["pay-1", "2026-11-07"],
    ["pay-2", "2026-11-10"],
  ]);
  expect(found[0]?.text).toContain("Fixit Co");
  expect(found[0]?.text.startsWith("- ")).toBe(false);
});

test("the owner's name never tells a matter apart: his words go, possessive included, anything else stays", () => {
  expect(
    withoutOwnerOf("Recover Sam's locked account for Sam Lee", "Sam Lee")
  ).toBe("Recover locked account for");
  expect(withoutOwnerOf("Pay the hosting bill", "Sam Lee")).toBe(
    "Pay the hosting bill"
  );
});
