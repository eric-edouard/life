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
  type Chance,
  type MoveRate,
  moveRatesOf,
  placeAmong,
  type Rate,
  type ReadOfCalls,
  seenExchanges,
  type Thing,
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
/** Each thing counted, in plain words after who did it. */
const WORDS: Record<Thing, string> = {
  affection: "says affection",
  against: "turns against the other's bid",
  apologises: "apologises",
  asks_about: "asks about the other",
  asks_for: "asks for something",
  away: "lets the other's bid pass",
  believes: "says what they believe",
  blames: "places blame",
  conflict: "a conflict",
  contempt: "shows contempt",
  counters: "counters with a fault of the other",
  decides: "settles it",
  defers: "leaves it to the other",
  denies: "denies",
  directs: "tells the other what to do",
  discloses: "discloses something personal",
  distress: "appeals to their own distress",
  engages: "engages with it",
  excuses: "makes an excuse",
  explores: "explores an idea",
  fault: "raises a fault",
  feels: "says how they feel",
  gives: "gives something",
  good_news: "shares good news",
  intends: "says what they intend",
  invites: "invites",
  mention: "talks about someone else",
  moves_on: "says let's move on",
  offers: "offers something",
  presses: "presses",
  proposes: "proposes",
  reassurance_asked: "asks for reassurance",
  refuses: "refuses",
  returns: "returns something",
  shares: "shares something of their day",
  support_asked: "asks for support",
  support_given: "gives support",
  tension: "some tension",
  thanks: "thanks",
  toward: "takes up the other's bid",
  unanswered: "leaves the other's bid unanswered",
  wants: "says what they want",
  warm: "reads warm",
  yields: "yields",
};
/** The page's sections, by what a rate is a share of. */
const SECTIONS: [Chance, string][] = [
  [
    "exchange",
    "Day to day: a share of the exchanges they wrote in, per channel",
  ],
  ["bid", "When the other reaches out (a bid): a share of the other's bids"],
  ["fault", "When the other raises a fault: a share of those exchanges"],
  ["decision", "When something is decided: a share of those exchanges"],
];
const labelOf = (r: MoveRate, name: string) => {
  const who = r.side === "me" ? "he " : `${name} `;
  return `${r.side ? who : ""}${WORDS[r.thing]}${r.source ? ` (${r.source})` : ""}`;
};

/** A person's page: where their rates stand among everyone's, lately against before, and every rate said. */
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
    const among = rest.filter((o) => o.says === "share").length;
    return r.all.says === "share" && Math.min(above, below) < ENDS
      ? [
          `- ${labelOf(r, name)}: ${sayRate(r.all)}; ${above} of ${among} other people are above, ${below} below`,
        ]
      : [];
  });
  const row = (r: MoveRate, ...rates: Rate[]) =>
    `| ${labelOf(r, name)} | ${rates.map(sayRate).join(" | ")} |`;
  const said = rows.filter((r) => r.all.says !== "exploratory");
  const flagged = said.filter((r) =>
    ["tension", "conflict", "warm"].includes(r.thing)
  );
  return [
    `# ${name}${relation ? ` (${relation})` : ""}`,
    "",
    `${exchanges} exchanges read. Counted by code from what the reads listed; a trial, outside his memory.`,
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
    ...SECTIONS.flatMap(([chance, title]) => [
      "",
      `## ${title}`,
      "",
      "| | All time |",
      "|---|---|",
      ...said
        .filter((r) => CHANCE[r.thing] === chance)
        .map((r) => row(r, r.all)),
    ]),
    "",
    "## Counted, not proven yet (two models do not agree enough, or too few test cases): no share is said",
    "",
    rows
      .filter((r) => r.all.says === "exploratory" && r.all.n > 0)
      .map((r) => `${labelOf(r, name)}: ${r.all.n} of ${r.all.of}`)
      .join("; "),
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
  // A page is written for a person with at least one share to say.
  const paged = rates.filter((p) => p.rows.some((r) => r.all.says === "share"));
  for (const p of paged) {
    writeFileSync(
      join(dir, `${p.name.replace(/[^\p{L}\p{N}]+/gu, "-")}.md`),
      `${pageOf(p.name, p.relation, p.rows, p.exchanges, others)}\n`
    );
  }
  console.table([
    {
      exchanges: rates.reduce((n, p) => n + p.exchanges, 0),
      missing,
      pages: paged.length,
      people: rates.length,
    },
  ]);
}
