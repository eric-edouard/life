import { expect, test } from "bun:test";
import type { Held } from "../sources/contract";
import {
  backfillEstimateOf,
  type HeldSource,
  TOKENS_PER_HOUR,
  TOKENS_PER_ITEM,
} from "./backfill";

// Made-up holdings: no disk, no store, only what a source's `held` says it holds.

const held = (count: number, earliest: string | null, noun: string): Held => ({
  count,
  earliest,
  noun,
});

const TODAY = "2025-01-01";

/** Tokens one item of `noun` is estimated at, without a possible `undefined` (the table is indexed by a word). */
const per = (noun: string) => TOKENS_PER_ITEM[noun] ?? 0;

test("items in the range are counted by days from the later of the picked day and the source's first", () => {
  const sources: HeldSource[] = [
    // 366 days of holding, from midday on 1 July: 184 of them are in the range.
    {
      held: held(1000, "2024-01-01T12:00:00.000Z", "messages"),
      name: "imessage",
    },
    // A source whose first item is after the picked day: all of it is in the range.
    { held: held(10, "2024-11-01T12:00:00.000Z", "photos"), name: "photos" },
    // Picked before its first item: the whole of it, and nothing older.
    { held: held(3, "2024-12-01T12:00:00.000Z", "commits"), name: "git" },
  ];
  const estimate = backfillEstimateOf(sources, "2024-07-01", "claude", TODAY);
  expect(estimate.tokens).toBe(
    Math.round((1000 * 184 * per("messages")) / 366) +
      10 * per("photos") +
      3 * per("commits")
  );
  expect(estimate.hours).toBeCloseTo(estimate.tokens / TOKENS_PER_HOUR);
});

test("a picked day before a source's first item counts the whole of it", () => {
  const sources: HeldSource[] = [
    { held: held(100, "2024-01-01T00:00:00.000Z", "messages"), name: "mail" },
  ];
  expect(
    backfillEstimateOf(sources, "2019-01-01", "claude", TODAY).tokens
  ).toBe(100 * per("messages"));
});

test("nothing in range: a picked day after today, a source with no first item, or a source missing", () => {
  const sources: HeldSource[] = [
    { held: held(100, "2024-01-01T00:00:00.000Z", "messages"), name: "mail" },
    { held: held(5, null, "notes"), name: "notes" },
    { held: null, name: "photos" },
  ];
  expect(backfillEstimateOf(sources, "2026-01-01", "claude", TODAY)).toEqual({
    hours: 0,
    tokens: 0,
  });
  expect(
    backfillEstimateOf(
      [{ held: null, name: "photos" }],
      "2024-01-01",
      "claude",
      TODAY
    )
  ).toEqual({ hours: 0, tokens: 0 });
});

test("a billed engine's credits are priced, a subscription has no dollars", () => {
  const sources: HeldSource[] = [
    { held: held(1000, "2024-01-01T00:00:00.000Z", "messages"), name: "mail" },
  ];
  // A day the OpenRouter row prices, the whole of a source first read on its first day.
  const day = "2026-12-01";
  const estimate = backfillEstimateOf(sources, "2024-01-01", "openrouter", day);
  expect(estimate.tokens).toBe(1000 * per("messages"));
  // The OpenRouter row: $0.15 a million input tokens.
  expect(estimate.usd).toBeCloseTo((estimate.tokens * 0.15) / 1e6);
  for (const engine of ["claude", "codex"] as const) {
    expect(
      backfillEstimateOf(sources, "2024-01-01", engine, day).usd
    ).toBeUndefined();
  }
});

test("a noun the table doesn't know is estimated as a message would be", () => {
  const sources: HeldSource[] = [
    { held: held(100, "2024-01-01T00:00:00.000Z", "widgets"), name: "made-up" },
  ];
  expect(
    backfillEstimateOf(sources, "2024-01-01", "claude", TODAY).tokens
  ).toBe(100 * per("messages"));
});
