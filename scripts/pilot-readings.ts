// `bun scripts/pilot-readings.ts`: a first look at counted readings (spec 9 and 10), from the whole-history reads kept
// by `memory-pilot.ts --all`. One page per person, written in his data (`docs/memory-rework/readings/`), never in
// `memory/`. Only wording is here: the counting is `memory/move-rates.ts`. Prints counts, never a word or a name.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clock, iso } from "@life/server/src/core/clock";
import { readJson } from "@life/server/src/core/files";
import { readWithPeople } from "@life/server/src/memory/closeness";
import {
  CHANCE,
  type MoveRate,
  moveRatesOf,
  placeAmong,
  type Rate,
  type ReadOfCalls,
  seenExchanges,
} from "@life/server/src/memory/move-rates";
import { checkedMoves, type ReadName } from "@life/server/src/memory/moves";
import { readPeople } from "@life/server/src/memory/who";
import { localDate } from "@life/server/src/memory/zones";
import { promptText } from "@life/server/src/models/llm";
import { allOf, KEPT, READS } from "./memory-pilot";

/** Standings are listed for a rate within this many places of either end. */
const ENDS = 3;

const sayRate = ({ n, of, says }: Rate) => {
  if (says === "share") {
    return `${Math.round((100 * n) / of)}% (${n} of ${of})`;
  }
  return `${says === "too few" ? "too few to say" : "counted, not said"} (${n} of ${of})`;
};
const idOf = (r: MoveRate) => `${r.thing}|${r.side}|${r.source}`;
const sideOf = (r: MoveRate, name: string) => {
  if (!r.side) {
    return "";
  }
  return r.side === "me" ? "he" : name;
};
const labelOf = (r: MoveRate, name: string) =>
  `${r.thing}, ${sideOf(r, name) || "the exchange"}${r.source ? `, ${r.source}` : ""} (${CHANCE[r.thing]})`;

/** A person's page: where their rates stand among everyone's, lately against before, and every rate. */
function pageOf(
  name: string,
  relation: string | null,
  rows: MoveRate[],
  exchanges: number,
  others: Map<string, { name: string; rate: Rate }[]>
) {
  const standing = rows.flatMap((r) => {
    const rest = (others.get(idOf(r)) ?? [])
      .filter((o) => o.name !== name)
      .map((o) => o.rate);
    const { above, below } = placeAmong(r.all, rest);
    return r.all.says === "share" && Math.min(above, below) < ENDS
      ? [
          `- ${labelOf(r, name)}: ${sayRate(r.all)}, ${above} above and ${below} below among ${rest.length} others`,
        ]
      : [];
  });
  const row = (r: MoveRate, ...rates: Rate[]) =>
    `| ${labelOf(r, name)} | ${rates.map(sayRate).join(" | ")} |`;
  const flagged = rows.filter((r) =>
    ["tension", "conflict", "warm"].includes(r.thing)
  );
  return [
    `# ${name}${relation ? ` (${relation})` : ""}`,
    "",
    `${exchanges} exchanges. A share is of the chance in brackets; a rate of an exchange chance is kept per source, never pooled; a bid met is by the side that met it.`,
    "",
    "## What stands out among the people of his life",
    "",
    ...(standing.length ? standing : ["Nothing at either end."]),
    "",
    "## Lately against before",
    "",
    "| | Last 12 months | Before |",
    "|---|---|---|",
    ...flagged.map((r) => row(r, r.lately, r.before)),
    "",
    "## Rates per side",
    "",
    "| | All time |",
    "|---|---|",
    ...rows.map((r) => row(r, r.all)),
  ].join("\n");
}

if (import.meta.main) {
  const { events } = await readWithPeople(new Date(0));
  const people = await readPeople();
  const byPerson = new Map<
    string,
    { reads: ReadOfCalls[]; relation: string | null }
  >();
  let missing = 0;
  const names = Object.keys(READS) as ReadName[];
  const wordings = await Promise.all(
    names.map((read) => promptText(READS[read].prompt))
  );
  for (const [i, read] of names.entries()) {
    const wording = wordings[i] ?? "";
    for (const call of allOf(events, people, wording)) {
      const kept = readJson<{ reply: unknown }>(
        join(KEPT, read, "openrouter", `${call.key}.json`)
      );
      if (!kept) {
        missing += 1;
        continue;
      }
      const { name, relation } = call.input.with;
      const person = byPerson.get(name) ?? { reads: [], relation };
      byPerson.set(name, person);
      person.reads.push({
        checked: checkedMoves(kept.reply, call.messages, call.starts, read)
          .exchanges,
        messages: call.messages,
        read,
        starts: call.starts,
      });
    }
  }
  const month = localDate(iso(+clock())).slice(0, 7);
  const rates = [...byPerson].map(([name, { reads, relation }]) => {
    const seen = seenExchanges(reads);
    return {
      exchanges: seen.length,
      name,
      relation,
      rows: moveRatesOf(seen, month),
    };
  });
  const others = new Map<string, { name: string; rate: Rate }[]>();
  for (const { name, rows } of rates) {
    for (const r of rows) {
      others.set(idOf(r), [
        ...(others.get(idOf(r)) ?? []),
        { name, rate: r.all },
      ]);
    }
  }
  const dir = join(KEPT, "..", "readings");
  mkdirSync(dir, { recursive: true });
  for (const p of rates) {
    writeFileSync(
      join(dir, `${p.name.replace(/[^\p{L}\p{N}]+/gu, "-")}.md`),
      `${pageOf(p.name, p.relation, p.rows, p.exchanges, others)}\n`
    );
  }
  console.table([
    {
      exchanges: rates.reduce((n, p) => n + p.exchanges, 0),
      missing,
      people: rates.length,
    },
  ]);
}
