// `bun scripts/pilot-agree.ts <read> <engine> <engine>`: how far two engines agree on a read of the pilot, over the
// exchanges both read (spec 15: per code, 0.5 or more with another family on at least 30 cases). With
// `--flag <engine>` instead: what the connection read's tension flag catches of the exchanges where the conflict
// read, by the same engine, found friction. Reads the replies kept by `memory-pilot.ts`; prints counts, never a word.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readJson } from "@life/server/src/core/files";
import { readWithPeople } from "@life/server/src/memory/closeness";
import type { SourceEvent } from "@life/server/src/records/source";
import { z } from "zod";
import {
  checkedMoves,
  KEPT,
  READS,
  type ReadName,
  readSet,
} from "./memory-pilot";

const Kept = z.object({
  messages: z.array(z.string()),
  reply: z.unknown(),
  starts: z.array(z.int()),
});
/** The conflict read's codes that say something went wrong between them (the rest is steering). */
const FRICTION = new Set([
  "fault",
  "contempt",
  "blames",
  "presses",
  "distress",
]);

/** One exchange as an engine read it: the marks it holds, each `<code>|<side>`, and its flags. */
interface Read {
  conflict?: boolean;
  marks: Set<string>;
  tension?: boolean;
}

/** Every exchange an engine read, by the id of its first message. */
function readsOf(
  read: ReadName,
  engine: string,
  events: Map<string, SourceEvent>
) {
  const dir = join(KEPT, read, engine);
  const out = new Map<string, Read>();
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    const kept = Kept.safeParse(readJson(join(dir, file)));
    const messages = kept.data?.messages.map((id) => events.get(id));
    if (!(kept.success && messages?.every(Boolean))) {
      continue;
    }
    const checked = checkedMoves(
      kept.data.reply,
      messages as SourceEvent[],
      kept.data.starts,
      read
    );
    for (const x of checked.exchanges) {
      out.set(kept.data.messages[x.exchange] as string, {
        conflict: x.conflict,
        marks: new Set(x.moves.map((m) => `${m.code}|${m.by}`)),
        tension: x.tension,
      });
    }
  }
  return out;
}

/** Cohen's kappa of two yes/no readings: `both` said yes, `a` or `b` alone, over `n` exchanges. */
export function kappaOf(both: number, a: number, b: number, n: number) {
  const agree = (both + (n - both - a - b)) / n;
  const yesA = (both + a) / n;
  const yesB = (both + b) / n;
  const chance = yesA * yesB + (1 - yesA) * (1 - yesB);
  return chance === 1 ? 1 : (agree - chance) / (1 - chance);
}

/** One row of the table: a mark, how often each engine made it, and their agreement. */
function rowOf(
  mark: string,
  shared: [Read, Read][],
  has: (r: Read) => boolean
) {
  let both = 0;
  let a = 0;
  let b = 0;
  for (const [x, y] of shared) {
    const [inA, inB] = [has(x), has(y)];
    both += inA && inB ? 1 : 0;
    a += inA && !inB ? 1 : 0;
    b += !inA && inB ? 1 : 0;
  }
  const cases = both + a + b;
  const kappa = Math.round(kappaOf(both, a, b, shared.length) * 100) / 100;
  let mark15 = "not proven (under 15)";
  if (cases >= 30) {
    mark15 = kappa >= 0.5 ? "holds" : "fails";
  } else if (cases >= 15) {
    mark15 = "too few (under 30)";
  }
  return { a: both + a, b: both + b, both, kappa, mark, result: mark15 };
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { flag: { type: "string" }, set: { type: "string" } },
  });
  // With `--set <name>`, only that test set's exchanges, read from its file: no source is opened.
  const all = values.set
    ? readSet(values.set).flatMap((s) => s.batch.flat())
    : (await readWithPeople(new Date(0))).events;
  const events = new Map(all.map((e) => [`${e.source}|${e.id}`, e]));
  if (values.flag) {
    const flagged = readsOf("connection", values.flag, events);
    const read = readsOf("conflict", values.flag, events);
    const shared = [...read].flatMap(([id, c]) => {
      const f = flagged.get(id);
      return f ? [[f, c] as const] : [];
    });
    const isFriction = (c: Read) =>
      [...c.marks].some((m) => FRICTION.has(m.split("|")[0] ?? ""));
    const friction = shared.filter(([, c]) => isFriction(c));
    console.table([
      {
        caught: friction.filter(([f]) => f.tension).length,
        exchanges: shared.length,
        flagged: shared.filter(([f]) => f.tension).length,
        friction: friction.length,
        missed: friction.filter(([f]) => !f.tension).length,
      },
    ]);
  } else {
    const [name = "", engineA = "", engineB = ""] = positionals;
    if (!(name in READS && engineA && engineB)) {
      throw new Error(
        "usage: bun scripts/pilot-agree.ts <read> <engine> <engine> | --flag <engine>"
      );
    }
    const a = readsOf(name as ReadName, engineA, events);
    const b = readsOf(name as ReadName, engineB, events);
    const shared = [...a].flatMap(([id, x]): [Read, Read][] => {
      const y = b.get(id);
      return y ? [[x, y]] : [];
    });
    const marks = [
      ...new Set(shared.flatMap(([x, y]) => [...x.marks, ...y.marks])),
    ].sort();
    console.log(
      `${name}: ${shared.length} exchanges read by both (${engineA} ${a.size}, ${engineB} ${b.size})`
    );
    console.table([
      ...(["tension", "conflict"] as const).flatMap((flag) =>
        shared.some(([x]) => x[flag] !== undefined)
          ? [rowOf(`(${flag})`, shared, (r) => r[flag] === true)]
          : []
      ),
      ...marks.map((m) => rowOf(m, shared, (r) => r.marks.has(m))),
    ]);
  }
}
