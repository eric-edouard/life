import { expect, test } from "bun:test";
import { listUsdOf, priceOn } from "./prices";

test("a price holds from its day until a later row; a day before every row has none", () => {
  const rows = [
    { from: "2026-01-01", item: "x", read: "", source: "", usdPerHour: 1 },
    { from: "2026-06-01", item: "x", read: "", source: "", usdPerHour: 2 },
  ];
  expect(priceOn(rows, "x", "2025-12-31")).toBeUndefined();
  expect(priceOn(rows, "x", "2026-05-31")?.usdPerHour).toBe(1);
  expect(priceOn(rows, "x", "2026-06-01")?.usdPerHour).toBe(2);
  expect(priceOn(rows, "y", "2026-06-01")).toBeUndefined();
});

test("tokens at list price: the cached part of the input at its own rate; an unknown model has none", () => {
  // codex:default, $2 in, $0.10 cached, $10 out per million.
  expect(
    listUsdOf("codex:default", "2026-11-21", {
      cached: 1e6,
      input: 2e6,
      output: 1e6,
    })
  ).toBeCloseTo(2 + 0.1 + 10);
  expect(listUsdOf("codex:made-up", "2026-11-21", NONE_TOKENS)).toBeUndefined();
});

const NONE_TOKENS = { cached: 0, input: 0, output: 0 };
