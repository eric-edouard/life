// `bun scripts/exchange-sizes.ts [person…]`: how his chats and mail with people cut into exchanges, over every year,
// as counts only: never a word, a name or a chat id (docs/operations.md, "Measuring"). With people named, a table
// for each one's one-to-one chats and mail, in the order given.

import { DAY, HOUR, MIN } from "@life/server/src/core/clock";
import { directOf, readWithPeople } from "@life/server/src/memory/closeness";
import {
  batchesOf,
  charsOf,
  EXCHANGE_BATCH_CHARS,
  exchangesOf,
  isTwoWay,
} from "@life/server/src/memory/exchanges";
import { readPeople } from "@life/server/src/memory/who";
import { CHARS_PER_TOKEN } from "@life/server/src/models/llm";
import { chatGroups, type SourceEvent } from "@life/server/src/records/source";

/** The quiet between two messages of a chat, by band: the upper bound of each. */
const BANDS: [string, number][] = [
  ["under 5 min", 5 * MIN],
  ["under 30 min", 30 * MIN],
  ["under 1 h", HOUR],
  ["under 3 h", 3 * HOUR],
  ["under 6 h", 6 * HOUR],
  ["under 12 h", 12 * HOUR],
  ["under 1 day", DAY],
  ["1 day or more", Number.POSITIVE_INFINITY],
];

const centile = (sorted: number[], share: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;

interface Row {
  calls: number;
  messages: number;
  oneSided: number;
  oversized: number;
  sizes: number[];
  twoWayChars: number;
}

/** How many times each quiet came between two messages of one chat. */
function quietOf(chats: SourceEvent[][]) {
  const counts = BANDS.map(() => 0);
  for (const chat of chats) {
    const sorted = chat.toSorted((a, b) => a.at.localeCompare(b.at));
    for (const [i, e] of sorted.slice(1).entries()) {
      const gap = Date.parse(e.at) - Date.parse((sorted[i] as SourceEvent).at);
      const band = BANDS.findIndex(([, under]) => gap < under);
      counts[band] = (counts[band] ?? 0) + 1;
    }
  }
  return BANDS.map(([band], i) => ({ band, count: counts[i] ?? 0 }));
}

/** One chat's exchanges and batches added to the rows they started in. */
function addChat(chat: SourceEvent[], rowOf: (first: SourceEvent) => Row) {
  const twoWay = isTwoWay(chat);
  for (const batch of batchesOf(exchangesOf(chat))) {
    const all = batch.flat();
    if (twoWay && all[0]) {
      const row = rowOf(all[0]);
      row.calls += 1;
      row.oversized += charsOf(all) > EXCHANGE_BATCH_CHARS ? 1 : 0;
    }
    for (const exchange of batch) {
      const [first] = exchange as [SourceEvent];
      const row = rowOf(first);
      const oneSided = exchange.every((e) => e.fromMe === first.fromMe);
      row.messages += exchange.length;
      row.oneSided += oneSided ? 1 : 0;
      row.sizes.push(charsOf(exchange));
      row.twoWayChars += twoWay ? charsOf(exchange) : 0;
    }
  }
}

/** A row as printed. */
function shown([key, r]: [string, Row]) {
  const sizes = r.sizes.toSorted((x, y) => x - y);
  return {
    calls: r.calls,
    chars: sizes.reduce((x, y) => x + y, 0),
    exchanges: sizes.length,
    key,
    median: centile(sizes, 0.5),
    messages: r.messages,
    ninetieth: centile(sizes, 0.9),
    oneSided: r.oneSided,
    oversized: r.oversized,
    tokensAtMost: Math.ceil(r.twoWayChars / CHARS_PER_TOKEN),
    twoWayChars: r.twoWayChars,
  };
}

/**
 * The counts of a set of messages: a row per source and year an exchange started in, and the quiet between messages.
 * For the chats both sides wrote in, the ones a read is for: their characters (`twoWayChars`), at most how many tokens
 * that is, the calls that read them a batch at a time (a batch counts in the row of its first exchange), and how
 * many of those batches are over the size (one exchange too long for a call).
 */
export function sizesOf(events: SourceEvent[]) {
  const rows = new Map<string, Row>();
  const rowOf = (first: SourceEvent) => {
    const key = `${first.source} ${first.at.slice(0, 4)}`;
    const row = rows.get(key) ?? {
      calls: 0,
      messages: 0,
      oneSided: 0,
      oversized: 0,
      sizes: [],
      twoWayChars: 0,
    };
    rows.set(key, row);
    return row;
  };
  const chats = [...chatGroups(events).values()];
  for (const chat of chats) {
    addChat(chat, rowOf);
  }
  return {
    quiet: quietOf(chats),
    rows: [...rows].map(shown).sort((x, y) => x.key.localeCompare(y.key)),
  };
}

if (import.meta.main) {
  const { events, failed } = await readWithPeople(new Date(0));
  const asked = process.argv.slice(2);
  if (asked.length > 0) {
    const named = directOf(asked, events, await readPeople());
    for (const [i, { known, messages }] of named.entries()) {
      console.log(`Person ${i + 1}${known ? "" : ": no one by that name"}`);
      console.table(sizesOf(messages).rows);
    }
  } else {
    const { quiet, rows } = sizesOf(events);
    console.table(rows);
    console.table(quiet);
  }
  console.log(
    failed.length > 0
      ? `Not read, so missing above: ${failed.join(", ")}`
      : "Every source was read."
  );
}
