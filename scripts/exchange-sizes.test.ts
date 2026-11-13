import { expect, test } from "bun:test";
import { HOUR, MIN } from "@life/server/src/core/clock";
import { EXCHANGE_BATCH_CHARS } from "@life/server/src/memory/exchanges";
import type { SourceEvent } from "@life/server/src/records/source";
import { sizesOf } from "./exchange-sizes";

const START = Date.parse("2025-12-31T20:00:00.000Z");
const msg = (
  ms: number,
  fromMe: boolean,
  text: string,
  chat = "+1"
): SourceEvent => ({
  at: new Date(START + ms).toISOString(),
  chat,
  fromMe,
  id: `${chat}:${ms}`,
  sender: fromMe ? "me" : chat,
  source: "whatsapp",
  text,
});

test("sizes: a row per source and year an exchange started in; one-sided exchanges; the chats both sides wrote in, their batches and tokens at most; the quiet by band, each chat apart", () => {
  const s = sizesOf([
    // One exchange across the new year, both sides: it belongs to 2025.
    msg(0, true, "aaaa"),
    msg(2 * MIN, false, "bb"),
    msg(5 * HOUR, true, "c"),
    // The next day, only he writes.
    msg(30 * HOUR, true, "dddddd"),
    // Another chat at the same time: never joined to the first, and never answered, so no read is sized for it.
    msg(1 * MIN, false, "ee", "+2"),
  ]);
  expect(s.rows).toEqual([
    {
      calls: 1,
      chars: 9,
      exchanges: 2,
      key: "whatsapp 2025",
      median: 7,
      messages: 4,
      ninetieth: 7,
      oneSided: 1,
      oversized: 0,
      tokensAtMost: 3,
      twoWayChars: 7,
    },
    {
      // Its exchange went in the batch that started in 2025: no call of its own.
      calls: 0,
      chars: 6,
      exchanges: 1,
      key: "whatsapp 2026",
      median: 6,
      messages: 1,
      ninetieth: 6,
      oneSided: 1,
      oversized: 0,
      tokensAtMost: 2,
      twoWayChars: 6,
    },
  ]);
  expect(s.quiet.filter((q) => q.count > 0)).toEqual([
    { band: "under 5 min", count: 1 },
    { band: "under 6 h", count: 1 },
    { band: "1 day or more", count: 1 },
  ]);
});

test("an exchange too long for one call is a batch alone, counted as oversized; the next exchange gets its own", () => {
  const long = "x".repeat(EXCHANGE_BATCH_CHARS + 1);
  const { rows } = sizesOf([
    msg(0, true, long),
    msg(1 * MIN, false, "ok"),
    msg(30 * HOUR, false, "hi"),
  ]);
  expect(rows.map((r) => [r.key, r.calls, r.oversized])).toEqual([
    ["whatsapp 2025", 1, 1],
    ["whatsapp 2026", 1, 0],
  ]);
});
