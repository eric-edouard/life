// `bun scripts/pilot-set.ts <name> [--rich <n>] [--plain <n>]`: saves a test set for the pilot, picked from the
// whole-history read kept by `memory-pilot.ts --all`: the `--rich` batches holding the most of what is rare (a
// conflict, friction, a disclosure, the codes with few cases) and `--plain` ordinary ones, in an order that never
// changes; or, with `--read <read> --codes <a,b> [--each <n>]`, the `n` batches holding the most of each code named.
// A set's batch is small (exchanges in a row up to `PER_CALL` messages), so a call takes a minute, not ten. They are saved
// whole in his data, so every later try reads the file, never his sources. Prints counts, never a word or a name.

import { parseArgs } from "node:util";
import { writeJson } from "@life/server/src/core/files";
import { digest } from "@life/server/src/core/hash";
import { packed } from "@life/server/src/core/lists";
import { directChats, readWithPeople } from "@life/server/src/memory/closeness";
import { batchesOf, isLiving } from "@life/server/src/memory/exchanges";
import type { CheckedExchange } from "@life/server/src/memory/moves";
import { readPeople } from "@life/server/src/memory/who";
import { promptText } from "@life/server/src/models/llm";
import type { ReadName } from "@life/server/src/records/read-reply";
import {
  chatGroups,
  eventKey,
  type SourceEvent,
} from "@life/server/src/records/source";
import { READS, readKept, setFile, type TestSet, withOf } from "./memory-pilot";

/** Messages a call of the test set holds at most (one longer exchange goes alone): small, so a try takes minutes. */
const PER_CALL = 120;
/** The codes a general sample holds too few of (round 3, 12 Nov 2026) or that failed there. */
const RARE = new Set(
  "apologises blames contempt counters denies distress engages excuses moves_on presses yields defers fault directs discloses explores good_news refuses reassurance_asked returns support_asked believes wants".split(
    " "
  )
);

type Events = Map<string, SourceEvent>;
const rareIn = (x: CheckedExchange) =>
  (x.conflict ? 3 : 0) +
  (x.tension ? 1 : 0) +
  x.moves.filter((m) => RARE.has(m.code)).length;

/** How much of what is rare each exchange holds, by its first message, over every read kept on `engine`. */
async function richness(engine: string, events: Events) {
  const score = new Map<string, number>();
  for (const read of Object.keys(READS) as ReadName[]) {
    // biome-ignore lint/performance/noAwaitInLoops: three reads
    const wording = await promptText(READS[read].prompt);
    for (const [first, x] of readKept(read, engine, events, wording)) {
      score.set(first, (score.get(first) ?? 0) + rareIn(x));
    }
  }
  return score;
}

/** The exchanges holding each of `codes`, by their first message, in the `read` kept on `engine`. */
async function holdersOf(
  read: ReadName,
  engine: string,
  codes: string[],
  events: Events
) {
  const holders = new Map(codes.map((c) => [c, new Set<string>()]));
  const wording = await promptText(READS[read].prompt);
  for (const [first, x] of readKept(read, engine, events, wording)) {
    for (const m of x.moves) {
      holders.get(m.code)?.add(first);
    }
  }
  return holders;
}

const idOf = (exchange: SourceEvent[]) =>
  exchange[0] ? eventKey(exchange[0]) : "";

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      codes: { type: "string" },
      each: { type: "string" },
      plain: { type: "string" },
      read: { type: "string" },
      rich: { type: "string" },
    },
  });
  const [name] = positionals;
  if (!name) {
    throw new Error(
      "usage: bun scripts/pilot-set.ts <name> [--rich <n>] [--plain <n>] | <name> --read <read> --codes <a,b> [--each <n>]"
    );
  }
  const { events } = await readWithPeople(new Date(0));
  const people = await readPeople();
  const byKey: Events = new Map(events.map((e) => [eventKey(e), e]));
  const score = await richness("openrouter", byKey);
  const all = [...directChats(events, people.resolve)]
    .filter(([ref]) => ref.startsWith("person:"))
    .flatMap(([ref, messages]) => {
      const withWhom = withOf(ref.slice("person:".length), people);
      return [...chatGroups(messages).values()]
        .filter(isLiving)
        .flatMap((chat) =>
          packed(batchesOf(chat).flat(), PER_CALL, (x) => x.length).map(
            (batch) => ({
              batch,
              id: batch[0] ? idOf(batch[0]) : "",
              score: batch.reduce((n, x) => n + (score.get(idOf(x)) ?? 0), 0),
              with: withWhom,
            })
          )
        );
    });
  // With `--codes a,b --read <read> [--each <n>]`: for each code in turn, the `n` batches not taken yet holding it in
  // the most exchanges, so every code named gets its cases; else the richest overall.
  const codes = values.codes?.split(",") ?? [];
  const holders = await holdersOf(
    (values.read ?? "connection") as ReadName,
    "openrouter",
    codes,
    byKey
  );
  const picked = new Set<string>();
  const byCode = codes.flatMap((code) => {
    const held = holders.get(code) ?? new Set();
    const best = all
      .filter((b) => !picked.has(b.id))
      .map((b) => ({ b, n: b.batch.filter((x) => held.has(idOf(x))).length }))
      .filter((x) => x.n > 0)
      .toSorted((x, y) => y.n - x.n || x.b.id.localeCompare(y.b.id))
      .slice(0, Number(values.each ?? 8))
      .map((x) => x.b);
    for (const b of best) {
      picked.add(b.id);
    }
    return best;
  });
  const rich =
    codes.length > 0
      ? byCode
      : all
          .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id))
          .slice(0, Number(values.rich ?? 40));
  const taken = new Set(rich.map((b) => b.id));
  const plain = all
    .filter((b) => !taken.has(b.id))
    .toSorted((a, b) =>
      digest("sha1", a.id, 12).localeCompare(digest("sha1", b.id, 12))
    )
    .slice(0, Number(values.plain ?? (codes.length > 0 ? 0 : 15)));
  const set: TestSet = [...rich, ...plain].map((b) => ({
    batch: b.batch,
    with: b.with,
  }));
  writeJson(setFile(name), set);
  console.table([
    {
      batches: set.length,
      exchanges: set.reduce((n, s) => n + s.batch.length, 0),
      leastRich: rich.at(-1)?.score ?? 0,
      messages: set.reduce((n, s) => n + s.batch.flat().length, 0),
      of: all.length,
      people: new Set(set.map((s) => s.with.name)).size,
      richest: rich[0]?.score ?? 0,
    },
  ]);
}
