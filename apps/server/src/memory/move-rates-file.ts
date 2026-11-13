import { z } from "zod";
import { clock } from "../core/clock";
import { readJson, writeJson } from "../core/files";
import { log } from "../core/log";
import { isoDateTime } from "../records/fields";
import { READ_NAMES, type ReadReply } from "../records/read-reply";
import { eventKey, type SourceEvent } from "../records/source";
import { directChats, type WithPeople } from "./closeness";
import { readReplyIndex, replyOf } from "./exchange-reads";
import { livingExchanges } from "./exchanges";
import { MOVE_RATES } from "./ledger";
import {
  CHANCE,
  type MoveRate,
  moveRatesOf,
  placeAmong,
  type ReadOfCalls,
  seenExchanges,
  type Thing,
} from "./move-rates";
import { checkedMoves } from "./moves";

// The move rates of every person (`moveRatesOf`), worked out each night from the stored reads (`exchange-reads.ts`)
// over today's exchanges and kept in one derived file (`MOVE_RATES`, Life's state, never his data) for the person
// read. What is shown is each row a share is said of, with its place among the other people, and a few conduct
// rows that are not proven, as raw counts.

const Count = z.object({ n: z.int().min(0), of: z.int().min(0) }).strict();
const Row = z
  .object({
    above: z.int().min(0),
    all: Count,
    among: z.int().min(0),
    before: Count,
    below: z.int().min(0),
    lately: Count,
    says: z.enum(["share", "exploratory"]),
    side: z.enum(["me", "them"]).optional(),
    source: z.string().optional(),
    thing: z.string(),
  })
  .strict();
export type StoredMoveRate = z.infer<typeof Row>;

const Stored = z
  .object({
    at: isoDateTime,
    month: z.string().regex(/^\d{4}-\d{2}$/),
    people: z.record(
      z.string(),
      z.object({ exchanges: z.int().min(0), rows: z.array(Row) }).strict()
    ),
  })
  .strict();

/** The not proven rows still kept: the answers to a fault, and the conduct lines asked for by name. */
const isConduct = (thing: Thing) =>
  CHANCE[thing] === "fault" ||
  thing === "blames" ||
  thing === "contempt" ||
  thing === "distress";

const rowKey = (r: MoveRate) => `${r.thing}|${r.side}|${r.source}`;

/**
 * What the stored reads say of one person's exchanges today: for each stored line holding exchanges that match
 * today's messages exactly (`replyOf`), its moves checked once. A line's other exchanges (changed since) are not used.
 */
function readsOf(events: SourceEvent[], index = readReplyIndex()) {
  const byKey = new Map(events.map((e) => [eventKey(e), e]));
  const held = new Map<
    ReadReply,
    { first: SourceEvent; starts: Set<number> }
  >();
  for (const x of livingExchanges(events).flat()) {
    for (const read of READ_NAMES) {
      const h = replyOf(x, read, index);
      const start = h?.line.starts[h.index];
      if (h && start !== undefined && x[0]) {
        const got = held.get(h.line) ?? { first: x[0], starts: new Set() };
        held.set(h.line, got);
        got.starts.add(start);
      }
    }
  }
  return [...held].map(([line, { first, starts }]): ReadOfCalls => {
    // A message another exchange of the line had that is gone now stands as the first one: only held exchanges are used.
    const messages = line.messages.map((k) => byKey.get(k) ?? first);
    const { exchanges } = checkedMoves(
      line.reply,
      messages,
      line.starts,
      line.read
    );
    return {
      checked: exchanges.filter((c) => starts.has(c.exchange)),
      messages,
      read: line.read,
      starts: line.starts,
    };
  });
}

/** Every person's rows kept, with their place among the others who have the same row. */
function keptRows(rates: Map<string, MoveRate[]>) {
  const rows = new Map<string, Map<string, MoveRate>>();
  for (const [ref, list] of rates) {
    for (const r of list) {
      const m = rows.get(rowKey(r)) ?? new Map<string, MoveRate>();
      rows.set(rowKey(r), m);
      m.set(ref, r);
    }
  }
  return new Map(
    [...rates].map(([ref, list]): [string, StoredMoveRate[]] => [
      ref,
      list.flatMap((r): StoredMoveRate[] => {
        const { all } = r;
        const keep =
          all.says === "share" ||
          (all.says === "exploratory" && all.n > 0 && isConduct(r.thing));
        if (!keep) {
          return [];
        }
        const others = [...(rows.get(rowKey(r)) ?? [])]
          .filter(([who]) => who !== ref)
          .map(([, o]) => o.all);
        const count = ({ n, of }: { n: number; of: number }) => ({ n, of });
        return [
          {
            ...placeAmong(all, others),
            all: count(all),
            before: count(r.before),
            lately: count(r.lately),
            says: all.says === "share" ? "share" : "exploratory",
            side: r.side,
            source: r.source,
            thing: r.thing,
          },
        ];
      }),
    ])
  );
}

/**
 * Works every person's move rates out from a read of all his years and rewrites the file whole, for the local `month`
 * (`YYYY-MM`) all people are compared over. Nothing is written when a source could not be read, or when it throws: it is
 * logged, `failed` says so and the last file stands.
 */
export function writeMoveRates(
  { events, failed }: Pick<WithPeople, "events" | "failed">,
  resolve: (s: string) => string | null,
  month: string
) {
  try {
    if (failed.length > 0) {
      throw new Error(`sources failed: ${failed.join(", ")}`);
    }
    const index = readReplyIndex();
    const seen = new Map(
      [...directChats(events, resolve)].map(([ref, list]) => [
        ref,
        seenExchanges(readsOf(list, index)),
      ])
    );
    const rows = keptRows(
      new Map([...seen].map(([ref, x]) => [ref, moveRatesOf(x, month)]))
    );
    const people = Object.fromEntries(
      [...seen].flatMap(([ref, x]) => {
        const list = rows.get(ref) ?? [];
        return list.length > 0
          ? [[ref, { exchanges: x.length, rows: list }]]
          : [];
      })
    );
    writeJson(
      MOVE_RATES,
      Stored.parse({ at: clock().toISOString(), month, people })
    );
    return { failed: 0, people: Object.keys(people).length };
  } catch (e) {
    log("run.error", {
      error: (e as Error).message,
      step: "memory.move-rates",
    });
    return { failed: 1, people: 0 };
  }
}

/** The stored move rates, or null when the file is missing or in another shape (then there are none). */
export const readMoveRates = () =>
  Stored.safeParse(readJson(MOVE_RATES)).data ?? null;
