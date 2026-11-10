// `bun scripts/exchange-sizes.ts`: how his chats and mail with people cut into exchanges, over every year, as counts
// only: never a word, a name or a chat id (docs/operations.md, "Measuring").

import { DAY, HOUR, MIN } from "@life/server/src/core/clock";
import { readWithPeople } from "@life/server/src/memory/closeness";
import { exchangesOf } from "@life/server/src/memory/exchanges";
import { isLifeOutput } from "@life/server/src/memory/units";
import { chatGroups, type SourceEvent } from "@life/server/src/records/source";

/** The characters of exchanges one call reads when a chat's are read together. */
const BATCH_CHARS = 30_000;
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
const chars = (list: SourceEvent[]) =>
  list.reduce((n, e) => n + e.text.length, 0);

interface Row {
  calls: number;
  living: number;
  messages: number;
  oneSided: number;
  sizes: number[];
}

/**
 * The counts of the messages with people (bulk mail and Life's own output left out, as the persona leaves them): a
 * row per source and year an exchange started in, and the quiet between messages.
 */
export function sizesOf(events: SourceEvent[]) {
  const rows = new Map<string, Row>();
  const quiet = BANDS.map(() => 0);
  const withPeople = events.filter((e) => !(e.bulk || isLifeOutput(e)));
  for (const chat of chatGroups(withPeople).values()) {
    const sorted = chat.toSorted((a, b) => a.at.localeCompare(b.at));
    for (const [i, e] of sorted.slice(1).entries()) {
      const gap = Date.parse(e.at) - Date.parse((sorted[i] as SourceEvent).at);
      const band = BANDS.findIndex(([, under]) => gap < under);
      quiet[band] = (quiet[band] ?? 0) + 1;
    }
    // A chat both sides wrote in is read, its exchanges of one year together: its characters that year, in calls of
    // BATCH_CHARS.
    const isLiving = chat.some((e) => e.fromMe) && chat.some((e) => !e.fromMe);
    const inYear = new Map<Row, number>();
    for (const exchange of exchangesOf(chat)) {
      const [first] = exchange as [SourceEvent];
      const key = `${first.source} ${first.at.slice(0, 4)}`;
      const row = rows.get(key) ?? {
        calls: 0,
        living: 0,
        messages: 0,
        oneSided: 0,
        sizes: [],
      };
      rows.set(key, row);
      row.messages += exchange.length;
      row.oneSided += exchange.every((e) => e.fromMe === first.fromMe) ? 1 : 0;
      row.sizes.push(chars(exchange));
      if (isLiving) {
        inYear.set(row, (inYear.get(row) ?? 0) + chars(exchange));
      }
    }
    for (const [row, n] of inYear) {
      row.living += n;
      row.calls += Math.ceil(n / BATCH_CHARS);
    }
  }
  return {
    quiet: BANDS.map(([band], i) => ({ band, count: quiet[i] ?? 0 })),
    rows: [...rows]
      .map(([key, r]) => {
        const sizes = r.sizes.toSorted((a, b) => a - b);
        return {
          calls: r.calls,
          chars: sizes.reduce((a, b) => a + b, 0),
          exchanges: sizes.length,
          key,
          living: r.living,
          median: centile(sizes, 0.5),
          messages: r.messages,
          ninetieth: centile(sizes, 0.9),
          oneSided: r.oneSided,
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

if (import.meta.main) {
  const { events, failed } = await readWithPeople(new Date(0));
  const { quiet, rows } = sizesOf(events);
  console.table(rows);
  console.table(quiet);
  console.log(
    failed.length > 0
      ? `Not read, so missing above: ${failed.join(", ")}`
      : "Every source was read."
  );
}
