// `bun scripts/pilot-set.ts <name> [--rich <n>] [--plain <n>]`: saves a test set for the pilot, picked from the
// whole-history read kept by `memory-pilot.ts --all`: the `--rich` batches holding the most of what is rare (a
// conflict, friction, a disclosure, the codes with few cases) and `--plain` ordinary ones, in an order that never
// changes. A set's batch is small (exchanges in a row up to `PER_CALL` messages), so a call takes a minute, not ten. They are saved
// whole in his data, so every later try reads the file, never his sources. Prints counts, never a word or a name.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readJson, writeJson } from "@life/server/src/core/files";
import { digest } from "@life/server/src/core/hash";
import { directChats, readWithPeople } from "@life/server/src/memory/closeness";
import { batchesOf, isLiving } from "@life/server/src/memory/exchanges";
import { readPeople } from "@life/server/src/memory/who";
import { chatGroups, type SourceEvent } from "@life/server/src/records/source";
import { KEPT, READS, setFile, type TestSet } from "./memory-pilot";

/** Messages a call of the test set holds at most (one longer exchange goes alone): small, so a try takes minutes. */
const PER_CALL = 120;
/** Exchanges in a row, cut each time the next one would pass `PER_CALL` messages. */
function smallBatches(exchanges: SourceEvent[][]) {
  const out: SourceEvent[][][] = [];
  let size = 0;
  for (const x of exchanges) {
    const last = out.at(-1);
    if (last && size + x.length <= PER_CALL) {
      last.push(x);
      size += x.length;
    } else {
      out.push([x]);
      size = x.length;
    }
  }
  return out;
}

/** The codes a general sample holds too few of (round 3, 12 Nov 2026) or that failed there. */
const RARE = new Set(
  "apologises blames contempt counters denies distress engages excuses moves_on presses yields defers fault directs discloses explores good_news refuses reassurance_asked returns support_asked believes wants".split(
    " "
  )
);

interface Kept {
  messages: string[];
  reply: {
    exchanges?: {
      conflict?: boolean;
      exchange: number;
      moves?: { code: string }[];
      tension?: boolean;
    }[];
  };
}

/** How much of what is rare each exchange holds, by its first message, over every read kept on `engine`. */
function richness(engine: string) {
  const score = new Map<string, number>();
  for (const read of Object.keys(READS)) {
    const dir = join(KEPT, read, engine);
    for (const file of existsSync(dir) ? readdirSync(dir) : []) {
      const kept = readJson<Kept>(join(dir, file));
      for (const x of kept?.reply.exchanges ?? []) {
        const first = kept?.messages[x.exchange];
        if (first) {
          const n =
            (x.conflict ? 3 : 0) +
            (x.tension ? 1 : 0) +
            (x.moves ?? []).filter((m) => RARE.has(m.code)).length;
          score.set(first, (score.get(first) ?? 0) + n);
        }
      }
    }
  }
  return score;
}

const idOf = (exchange: SourceEvent[]) =>
  exchange[0] ? `${exchange[0].source}|${exchange[0].id}` : "";

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { plain: { type: "string" }, rich: { type: "string" } },
  });
  const [name] = positionals;
  if (!name) {
    throw new Error(
      "usage: bun scripts/pilot-set.ts <name> [--rich <n>] [--plain <n>]"
    );
  }
  const score = richness("openrouter");
  const { events } = await readWithPeople(new Date(0));
  const people = await readPeople();
  const all = [...directChats(events, people.resolve)]
    .filter(([ref]) => ref.startsWith("person:"))
    .flatMap(([ref, messages]) => {
      const known = ref.slice("person:".length);
      const withWhom = {
        name: people.nameOf(ref),
        relation:
          people.truth.people.find((p) => p.id === known)?.relation ?? null,
      };
      return [...chatGroups(messages).values()]
        .filter(isLiving)
        .flatMap((chat) =>
          smallBatches(batchesOf(chat).flat()).map((batch) => ({
            batch,
            id: batch[0] ? idOf(batch[0]) : "",
            score: batch.reduce((n, x) => n + (score.get(idOf(x)) ?? 0), 0),
            with: withWhom,
          }))
        );
    });
  const rich = all
    .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Number(values.rich ?? 40));
  const taken = new Set(rich.map((b) => b.id));
  const plain = all
    .filter((b) => !taken.has(b.id))
    .toSorted((a, b) =>
      digest("sha1", a.id, 12).localeCompare(digest("sha1", b.id, 12))
    )
    .slice(0, Number(values.plain ?? 15));
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
