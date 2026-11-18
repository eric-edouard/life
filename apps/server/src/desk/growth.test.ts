import { expect, test } from "bun:test";
import { growthOf } from "./agent-wait";

test("growthOf: from the first call to the newest kept context; null values skipped; 0 when either is missing", () => {
  const turns = [
    { context_used: null },
    { context_used: 41_000 },
    { context_used: 20_000 },
  ];
  expect(growthOf({ context_at_first_call: 5000 }, turns)).toBe(36_000);
  expect(growthOf({ context_at_first_call: null }, turns)).toBe(0);
  expect(growthOf(null, turns)).toBe(0);
  expect(
    growthOf({ context_at_first_call: 5000 }, [{ context_used: null }])
  ).toBe(0);
});
