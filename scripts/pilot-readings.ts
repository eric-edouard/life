// `bun scripts/pilot-readings.ts`: a first look at counted readings (spec 9 and 10), by code, from the whole-history
// read kept by `memory-pilot.ts --all`. One page per person with enough exchanges, written in his data
// (`docs/memory-rework/readings/`), never in `memory/`. A trial of what an agent would see, not the stored layer.
// Prints counts, never a word or a name.
// ponytail: channels are pooled and a pattern list is not counted; the real counting code (path, step 5.1) keeps
// them apart.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "@life/server/src/core/files";
import { readWithPeople } from "@life/server/src/memory/closeness";
import { readPeople } from "@life/server/src/memory/who";
import { promptText } from "@life/server/src/models/llm";
import {
  allOf,
  checkedMoves,
  KEPT,
  READS,
  type ReadName,
} from "./memory-pilot";

/** Under this many chances a rate is not shown (spec 9: "too few to say"). */
const MINIMUM = 15;
const SIDES = ["me", "them"] as const;
type Side = (typeof SIDES)[number];
const OPENINGS = [
  "shares",
  "discloses",
  "good_news",
  "invites",
  "asks_for",
  "offers",
  "support_asked",
  "reassurance_asked",
];
const ANSWERS = [
  "engages",
  "apologises",
  "excuses",
  "denies",
  "counters",
  "yields",
  "moves_on",
];
const STEERS = ["directs", "proposes", "defers", "decides"];

/** One exchange as every read saw it: who wrote in it, and each read's moves and flags. */
interface Seen {
  at: Date;
  conflict?: boolean;
  moves: {
    answer?: { kind: string };
    by: Side;
    code: string;
    depth?: number;
    quote: string;
    strength?: number;
    to?: number;
    line: number;
  }[];
  tension?: boolean;
  tone: { me?: string | null; them?: string | null };
  wrote: Set<Side>;
}

const share = (n: number, of: number) =>
  of < MINIMUM
    ? `too few to say (${n} of ${of})`
    : `${Math.round((100 * n) / of)}% (${n} of ${of})`;

/** A rate of a page, kept so people can be set side by side: what it counts, and its share of its chances. */
interface Rate {
  n: number;
  of: number;
  what: string;
}
const YEAR_MS = 365 * 24 * 3600 * 1000;

/** A person's page: rates per side, each a share of its chances, with the year by year volume and tension. */
function pageOf(name: string, relation: string | null, seen: Seen[]) {
  const rates: Rate[] = [];
  const rate = (what: string, n: number, of: number) => {
    rates.push({ n, of, what });
    return share(n, of);
  };
  const took = (s: Side) => seen.filter((x) => x.wrote.has(s));
  const has = (x: Seen, s: Side, code: string) =>
    x.moves.some((m) => m.by === s && m.code === code);
  const label = (s: Side) => (s === "me" ? "He" : name);
  const out: string[] = [
    `# ${name}${relation ? ` (${relation})` : ""}`,
    "",
    `${seen.length} exchanges, ${seen[0]?.at.toISOString().slice(0, 10)} to ${seen.at(-1)?.at.toISOString().slice(0, 10)}. Each line: a share of the exchanges that side wrote in, unless it names another chance.`,
    "",
    "## By year",
    "",
    "| Year | Exchanges | Tense | Conflict | He reads warm | They read warm |",
    "|---|---|---|---|---|---|",
  ];
  const years = Map.groupBy(seen, (x) => x.at.getUTCFullYear());
  for (const [year, list] of [...years].sort(([a], [b]) => a - b)) {
    const warm = (s: Side) => {
      const toned = list.filter((x) => x.tone[s]);
      return share(
        toned.filter((x) => x.tone[s] === "warm").length,
        toned.length
      );
    };
    out.push(
      `| ${year} | ${list.length} | ${share(list.filter((x) => x.tension).length, list.length)} | ${share(list.filter((x) => x.conflict).length, list.length)} | ${warm("me")} | ${warm("them")} |`
    );
  }
  const table = (title: string, codes: string[]) => {
    out.push("", `## ${title}`, "", `| Move | He | ${name} |`, "|---|---|---|");
    for (const code of codes) {
      out.push(
        `| ${code} | ${SIDES.map((s) => rate(`${code}, by ${s === "me" ? "him" : "them"}`, took(s).filter((x) => has(x, s, code)).length, took(s).length)).join(" | ")} |`
      );
    }
  };
  table("Connection", [
    "asks_about",
    "shares",
    "discloses",
    "good_news",
    "affection",
    "thanks",
    "support_given",
    "support_asked",
    "reassurance_asked",
    "invites",
    "explores",
  ]);
  table("Giving and asking", ["asks_for", "offers", "gives", "refuses"]);
  table("Mentions and self-reports", [
    "mention",
    "feels",
    "intends",
    "wants",
    "believes",
  ]);
  out.push(
    "",
    "## How an opening is met (chance: the opening)",
    "",
    "| Opening by | Met | Turned away | Turned against | No answer |",
    "|---|---|---|---|---|"
  );
  for (const s of SIDES) {
    const openings = seen.flatMap((x) =>
      x.moves.filter((m) => m.by === s && OPENINGS.includes(m.code))
    );
    const kind = (k: string | undefined) =>
      rate(
        `${s === "me" ? "his" : "their"} openings ${k ? `met ${k}` : "left with no answer"}`,
        openings.filter((m) => m.answer?.kind === k).length,
        openings.length
      );
    out.push(
      `| ${label(s)} | ${kind("toward")} | ${kind("away")} | ${kind("against")} | ${kind(undefined)} |`
    );
  }
  out.push(
    "",
    "## When a fault is raised (chance: an exchange where that side raised one)",
    "",
    `| The other then… | When he raises it | When ${name} raises it |`,
    "|---|---|---|"
  );
  const faulted = (s: Side) => seen.filter((x) => has(x, s, "fault"));
  const other = (s: Side): Side => (s === "me" ? "them" : "me");
  for (const code of ANSWERS) {
    out.push(
      `| ${code} | ${SIDES.map((s) => rate(`${s === "me" ? "they" : "he"} ${code} when faulted`, faulted(s).filter((x) => has(x, other(s), code)).length, faulted(s).length)).join(" | ")} |`
    );
  }
  out.push(
    "",
    `Faults raised: he in ${rate("fault raised, by him", faulted("me").length, took("me").length)}, ${name} in ${rate("fault raised, by them", faulted("them").length, took("them").length)}. Presses: he ${rate("presses, by him", took("me").filter((x) => has(x, "me", "presses")).length, took("me").length)}, ${name} ${rate("presses, by them", took("them").filter((x) => has(x, "them", "presses")).length, took("them").length)}.`,
    "",
    "## Who steers (chance: an exchange with something to decide)",
    "",
    `| Move | He | ${name} |`,
    "|---|---|---|"
  );
  const atStake = seen.filter((x) =>
    x.moves.some((m) => STEERS.includes(m.code))
  );
  for (const code of STEERS) {
    out.push(
      `| ${code} | ${SIDES.map((s) => rate(`${code} when something is decided, by ${s === "me" ? "him" : "them"}`, atStake.filter((x) => has(x, s, code)).length, atStake.length)).join(" | ")} |`
    );
  }
  // Lately against before (spec 9): the last twelve months beside everything earlier.
  const since = +(seen.at(-1)?.at ?? 0) - YEAR_MS;
  const [lately, before] = [
    seen.filter((x) => +x.at >= since),
    seen.filter((x) => +x.at < since),
  ];
  const warm = (list: Seen[], s: Side) => {
    const toned = list.filter((x) => x.tone[s]);
    return [
      toned.filter((x) => x.tone[s] === "warm").length,
      toned.length,
    ] as const;
  };
  const flagged = (list: Seen[], flag: "conflict" | "tension") =>
    [list.filter((x) => x[flag]).length, list.length] as const;
  const trend = (
    what: string,
    of: (list: Seen[]) => readonly [number, number]
  ) =>
    `| ${what} | ${rate(`${what}, last 12 months`, ...of(lately))} | ${share(...of(before))} |`;
  const trends = [
    "",
    "## Lately against before",
    "",
    "| | Last 12 months | Before |",
    "|---|---|---|",
    trend("tense", (l) => flagged(l, "tension")),
    trend("conflict", (l) => flagged(l, "conflict")),
    trend("he reads warm", (l) => warm(l, "me")),
    trend("they read warm", (l) => warm(l, "them")),
  ];
  return { head: out.slice(0, 3), rates, rest: [...trends, ...out.slice(3)] };
}

/** Where each of a person's rates sits among everyone with enough chances: the few at either end, the furthest first. */
function standingOf(mine: Rate[], all: Rate[][]) {
  const lines = mine.flatMap((r) => {
    if (r.of < MINIMUM) {
      return [];
    }
    const shares = all
      .flatMap((rs) => rs.filter((o) => o.what === r.what && o.of >= MINIMUM))
      .map((o) => o.n / o.of)
      .sort((a, b) => b - a);
    const rank = shares.indexOf(r.n / r.of) + 1;
    const fromEnd = Math.min(rank, shares.length + 1 - rank);
    // An end of the list means something only among enough people, and when the rate is not nil for nearly everyone.
    return shares.length >= 10 && fromEnd <= 3 && (shares[2] ?? 0) > 0.02
      ? [
          {
            fromEnd,
            line: `- ${r.what}: ${share(r.n, r.of)}, ${rank <= 3 ? `rank ${rank}` : `rank ${rank} (${shares.length + 1 - rank} from the lowest)`} of ${shares.length} people`,
          },
        ]
      : [];
  });
  return lines.sort((a, b) => a.fromEnd - b.fromEnd).map((l) => l.line);
}

if (import.meta.main) {
  const { events } = await readWithPeople(new Date(0));
  const people = await readPeople();
  const byPerson = new Map<
    string,
    { relation: string | null; seen: Map<string, Seen> }
  >();
  const counts = { exchanges: 0, missing: 0, moves: 0 };
  const names = Object.keys(READS) as ReadName[];
  const wordings = await Promise.all(
    names.map((name) => promptText(READS[name].prompt))
  );
  for (const [i, name] of names.entries()) {
    const wording = wordings[i] ?? "";
    for (const call of allOf(events, people, wording)) {
      const kept = readJson<{ reply: unknown }>(
        join(KEPT, name, "openrouter", `${call.key}.json`)
      );
      if (!kept) {
        counts.missing += 1;
        continue;
      }
      const person = byPerson.get(call.input.with.name) ?? {
        relation: call.input.with.relation,
        seen: new Map<string, Seen>(),
      };
      byPerson.set(call.input.with.name, person);
      const { exchanges } = checkedMoves(
        kept.reply,
        call.messages,
        call.starts,
        name
      );
      for (const x of exchanges) {
        const first = call.messages[x.exchange];
        if (!first) {
          continue;
        }
        const id = `${first.source}|${first.id}`;
        const end =
          call.starts[call.starts.indexOf(x.exchange) + 1] ??
          call.messages.length;
        const seen = person.seen.get(id) ?? {
          at: new Date(first.at),
          moves: [],
          tone: {},
          wrote: new Set(
            call.messages
              .slice(x.exchange, end)
              .filter((m) => !m.phoneCall)
              .map((m): Side => (m.fromMe ? "me" : "them"))
          ),
        };
        person.seen.set(id, seen);
        seen.moves.push(...(x.moves as Seen["moves"]));
        seen.conflict ??= x.conflict;
        seen.tension ??= x.tension;
        seen.tone = { ...seen.tone, ...x.tone };
        counts.moves += x.moves.length;
      }
    }
  }
  const dir = join(KEPT, "..", "readings");
  mkdirSync(dir, { recursive: true });
  const pages = [...byPerson].flatMap(([name, { relation, seen }]) => {
    const list = [...seen.values()].sort((a, b) => +a.at - +b.at);
    counts.exchanges += list.length;
    return list.length >= 2 * MINIMUM
      ? [{ name, ...pageOf(name, relation, list) }]
      : [];
  });
  const all = pages.map((p) => p.rates);
  for (const p of pages) {
    const standing = standingOf(p.rates, all);
    writeFileSync(
      join(dir, `${p.name.replace(/[^\p{L}\p{N}]+/gu, "-")}.md`),
      `${[...p.head, "", "## What stands out among the people of his life", "", ...(standing.length ? standing : ["Nothing at either end."]), ...p.rest].join("\n")}\n`
    );
  }
  console.table([{ ...counts, pages: pages.length, people: byPerson.size }]);
}
