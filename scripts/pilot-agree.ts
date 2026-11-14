// `bun scripts/pilot-agree.ts <read> <label|folder> <label|folder> [--set <a,b>] [--bar 0.5] [--by-eye <n>]`: how far two trial
// folders of a read agree, over the exchanges both read (spec 15: per code, the bar or more with another family on at
// least 30 cases), so two wordings compare as well as two models. After the table: whom the moves are aimed at, and for
// the mentions read who is meant (`people`), by proof. `--by-eye <n>`: the first side's pronouns placed by an earlier
// naming, written to his trials folder for him to read. With `--flag <label>` instead: what the connection read's
// tension flag catches of the exchanges where the conflict read, by the same label, found friction. Reads the trial
// files kept by `memory-pilot.ts`; prints counts, never a word.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { digest } from "@life/server/src/core/hash";
import { OWNER_DATA_DIR } from "@life/server/src/core/paths";
import { readWithPeople } from "@life/server/src/memory/closeness";
import { READS } from "@life/server/src/memory/exchange-reads";
import { placementOf } from "@life/server/src/memory/mention-placement";
import { mentionOf } from "@life/server/src/memory/mentions";
import type { CheckedExchange } from "@life/server/src/memory/moves";
import { type Tie, tiesNow } from "@life/server/src/memory/ties";
import { nameKey } from "@life/server/src/memory/units";
import { type People, readPeople } from "@life/server/src/memory/who";
import { senderOf } from "@life/server/src/memory/words";
import type { ReadName } from "@life/server/src/records/read-reply";
import { eventKey, type SourceEvent } from "@life/server/src/records/source";
import { folderOf, readKept, readSet } from "./memory-pilot";

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

/** What a move is graded as, beside its code: how a bid was met, a deep disclosure, a mention's tone, a strong fault, where blame goes. */
function gradesOf(move: Record<string, unknown>) {
  const answer = (move.answer as { kind?: string } | undefined)?.kind;
  return [
    ...(answer ? [`(met ${answer})`] : []),
    ...(move.code === "discloses" && Number(move.depth) >= 2
      ? ["discloses (deep)"]
      : []),
    ...(move.code === "mention" && move.tone !== "neutral"
      ? [`mention (${move.tone})`]
      : []),
    ...(move.code === "mention" && move.kind === "judgement"
      ? ["mention (judgement)"]
      : []),
    ...(move.code === "fault" && Number(move.strength) >= 2
      ? ["fault (strong)"]
      : []),
    ...(move.code === "blames" ? [`blames (${move.on})`] : []),
  ];
}

/** What a trial folder holds, checked: an exchange by its first message's key. */
export type Kept = Map<string, CheckedExchange & { messages: SourceEvent[] }>;

/** Every exchange a folder read, by the key of its first message: its marks (codes, grades, a tone that is not neutral). */
const readsOf = (kept: Kept) =>
  new Map(
    [...kept].map(([key, x]): [string, Read] => [
      key,
      {
        conflict: x.conflict,
        marks: new Set([
          ...x.moves.map((m) => `${m.code}|${m.by}`),
          ...x.moves.flatMap((m) => gradesOf(m).map((g) => `${g}|${m.by}`)),
          ...(["me", "them"] as const).flatMap((side) =>
            x.tone[side] && x.tone[side] !== "neutral"
              ? [`(tone ${x.tone[side]})|${side}`]
              : []
          ),
        ]),
        tension: x.tension,
      },
    ])
  );

/** Cohen's kappa of two yes/no readings: `both` said yes, `a` or `b` alone, over `n` exchanges. */
function kappaOf(both: number, a: number, b: number, n: number) {
  const agree = (both + (n - both - a - b)) / n;
  const yesA = (both + a) / n;
  const yesB = (both + b) / n;
  const chance = yesA * yesB + (1 - yesA) * (1 - yesB);
  return chance === 1 ? 1 : (agree - chance) / (1 - chance);
}

/** One row of the table: a mark, how often each side made it, and their agreement; `result` is judged at `bar` once there are 30 cases. */
export function rowOf(
  mark: string,
  shared: [Read, Read][],
  has: (r: Read) => boolean,
  bar = 0.5
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
  let result = "not proven (under 15)";
  if (cases >= 30) {
    result = kappa >= bar ? "holds" : "fails";
  } else if (cases >= 15) {
    result = "too few (under 30)";
  }
  return { a: both + a, b: both + b, both, kappa, mark, result };
}

/**
 * Whom the moves are aimed at, between two readings: over the moves both list with the same exchange, code and line's
 * speaker (paired in order when a speaker has several), how many, how many with the same `aimedAt`, the share.
 */
export function aimedAtOf(
  a: Kept,
  b: Kept,
  speakerOf: (e: SourceEvent) => string
) {
  let moves = 0;
  let same = 0;
  const byKind = (x: Kept extends Map<string, infer V> ? V : never) =>
    Map.groupBy(
      x.moves,
      (m) => `${m.code}|${speakerOf(x.messages[m.line] as SourceEvent)}`
    );
  for (const [key, x] of a) {
    const y = b.get(key);
    const theirs = y ? byKind(y) : new Map();
    for (const [kind, mine] of byKind(x)) {
      const other = theirs.get(kind) ?? [];
      for (const [i, m] of mine.slice(0, other.length).entries()) {
        moves += 1;
        same +=
          m.aimedAt !== undefined && m.aimedAt === other[i]?.aimedAt ? 1 : 0;
      }
    }
  }
  return {
    moves,
    same,
    share: moves > 0 ? Math.round((same / moves) * 100) / 100 : 0,
  };
}

/** One mention of a reading with the message it is on. */
interface Placed {
  key: string;
  mention: NonNullable<ReturnType<typeof mentionOf>>;
}
const mentionsIn = (kept: Kept): Placed[] =>
  [...kept.values()].flatMap((x) =>
    x.moves.flatMap((m) => {
      const mention = mentionOf(x.messages, m);
      const message = x.messages[m.line];
      return mention && message ? [{ key: eventKey(message), mention }] : [];
    })
  );

type Placing = Pick<People, "canon" | "resolve">;
/** A mention's placement with its read's pick, and with the pick removed: code's own reading alone. */
function placementsOf({ mention }: Placed, people: Placing, ties: Tie[]) {
  return {
    full: placementOf(mention, people, ties),
    own: placementOf(
      { ...mention, namedOn: undefined, ref: undefined },
      people,
      ties
    ),
  };
}

/**
 * Who a reading's mentions mean, counted: its mentions, its picks that are not `unknown`, those placed by each proof,
 * those code places alone (the pick removed), the pronouns that gave `namedOn` and those it proved; and against code's
 * own reading, the picks that agree with it, those it vetoes (a name it places that the pick contradicts) and the names
 * it places that the read answered `unknown`.
 */
export function peopleOf(kept: Kept, people: Placing, ties: Tie[]) {
  const counts = {
    agree: 0,
    byCodeAlone: 0,
    byEarlierNaming: 0,
    byName: 0,
    byRelationWord: 0,
    mentions: 0,
    namedOnGiven: 0,
    namedOnPassing: 0,
    picks: 0,
    unknownOverCode: 0,
    vetoed: 0,
  };
  for (const placed of mentionsIn(kept)) {
    const flags = flagsOf(placed, people, ties);
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
      counts[key] += flags[key] ? 1 : 0;
    }
  }
  return counts;
}

/** What one mention counts toward (`peopleOf`). */
function flagsOf(placed: Placed, people: Placing, ties: Tie[]) {
  const { mention } = placed;
  const { full, own } = placementsOf(placed, people, ties);
  const hasPick = !!mention.ref && mention.ref !== "unknown";
  const pick = hasPick ? people.canon(mention.ref as string) : undefined;
  const proved = (proof: string) => full?.proof === proof;
  return {
    agree: !!own && !!pick && own.ref === pick,
    byCodeAlone: !!own,
    byEarlierNaming: proved("earlier_naming"),
    byName: proved("name"),
    byRelationWord: proved("relation_word"),
    mentions: true,
    namedOnGiven: !!mention.namedOn,
    namedOnPassing: proved("earlier_naming"),
    picks: hasPick,
    unknownOverCode: !!own && mention.ref === "unknown",
    vetoed: !!own && !!pick && own.ref !== pick,
  };
}

/** Between two readings, over the mentions on the same message with the same `who`: both placed, the same person, a different person. */
export function peopleBetween(a: Kept, b: Kept, people: Placing, ties: Tie[]) {
  const theirs = new Map(
    mentionsIn(b).map((p) => [`${p.key}|${nameKey(p.mention.who)}`, p])
  );
  const out = { bothPlaced: 0, differentPerson: 0, samePerson: 0 };
  for (const p of mentionsIn(a)) {
    const q = theirs.get(`${p.key}|${nameKey(p.mention.who)}`);
    const [x, y] = [
      placementsOf(p, people, ties).full,
      q && placementsOf(q, people, ties).full,
    ];
    if (x && y) {
      out.bothPlaced += 1;
      out[x.ref === y.ref ? "samePerson" : "differentPerson"] += 1;
    }
  }
  return out;
}

/**
 * The first `n` mentions a reading placed by an earlier naming, in an order that never changes (the digest of their
 * message's key): the pronoun's line and words, the earlier line, and whom it was placed on, for a person to read.
 */
export function byEyeOf(
  kept: Kept,
  n: number,
  people: Pick<People, "canon" | "resolve" | "nameOf">,
  ties: Tie[]
) {
  return mentionsIn(kept)
    .flatMap((p) => {
      const { full } = placementsOf(p, people, ties);
      return full?.proof === "earlier_naming" && p.mention.namedOn
        ? [
            {
              earlier: p.mention.namedOn.line,
              key: p.key,
              line: p.mention.line,
              name: people.nameOf(full.ref),
              who: p.mention.who,
            },
          ]
        : [];
    })
    .toSorted((x, y) =>
      digest("sha1", x.key, 12).localeCompare(digest("sha1", y.key, 12))
    )
    .slice(0, n);
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      bar: { type: "string" },
      "by-eye": { type: "string" },
      flag: { type: "string" },
      set: { type: "string" },
    },
  });
  // With `--set <name>[,<name>]`, only those test sets' exchanges, read from its file: no source is opened.
  const all = values.set
    ? values.set
        .split(",")
        .flatMap((name) => readSet(name).flatMap((s) => s.batch.flat()))
    : (await readWithPeople(new Date(0))).events;
  const events = new Map(all.map((e) => [eventKey(e), e]));
  const people = await readPeople();
  const ties = tiesNow(people);
  const speakerOf = (e: SourceEvent) => senderOf(e, people);
  const keptOf = (read: ReadName, label: string) =>
    readKept(read, folderOf(read, label), events, speakerOf);
  if (values.flag) {
    const flagged = readsOf(keptOf("connection", values.flag));
    const read = readsOf(keptOf("conflict", values.flag));
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
    const [name = "", labelA = "", labelB = ""] = positionals;
    if (!(name in READS && labelA && labelB)) {
      throw new Error(
        "usage: bun scripts/pilot-agree.ts <read> <label|folder> <label|folder> [--set <a,b>] [--bar 0.5] [--by-eye <n>] | --flag <label>"
      );
    }
    const read = name as ReadName;
    const bar = values.bar ? Number(values.bar) : 0.5;
    const [keptA, keptB] = [keptOf(read, labelA), keptOf(read, labelB)];
    const [a, b] = [readsOf(keptA), readsOf(keptB)];
    const shared = [...a].flatMap(([id, x]): [Read, Read][] => {
      const y = b.get(id);
      return y ? [[x, y]] : [];
    });
    const marks = [
      ...new Set(shared.flatMap(([x, y]) => [...x.marks, ...y.marks])),
    ].sort();
    console.log(
      `${name}: ${shared.length} exchanges read by both (${labelA} ${a.size}, ${labelB} ${b.size}), bar ${bar}`
    );
    console.table([
      ...(["tension", "conflict"] as const).flatMap((flag) =>
        shared.some(([x]) => x[flag] !== undefined)
          ? [rowOf(`(${flag})`, shared, (r) => r[flag] === true, bar)]
          : []
      ),
      ...marks.map((m) => rowOf(m, shared, (r) => r.marks.has(m), bar)),
    ]);
    console.log("aimed at, over the moves both list:");
    console.table([aimedAtOf(keptA, keptB, speakerOf)]);
    if (read === "mentions") {
      console.log("who is meant, by side and between them:");
      console.table([
        { side: labelA, ...peopleOf(keptA, people, ties) },
        { side: labelB, ...peopleOf(keptB, people, ties) },
      ]);
      console.table([peopleBetween(keptA, keptB, people, ties)]);
      if (values["by-eye"]) {
        const rows = byEyeOf(keptA, Number(values["by-eye"]), people, ties);
        const dir = join(OWNER_DATA_DIR, "docs", "memory-rework", "trials");
        const file = join(dir, `b1-pronouns-${labelA}.md`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          file,
          `${rows
            .map(
              (r, i) =>
                `${i + 1}. said: ${r.line}\n   pronoun: ${r.who}\n   earlier line: ${r.earlier}\n   placed on: ${r.name}`
            )
            .join("\n\n")}\n`
        );
        console.log(`${rows.length} pronouns to read by eye: ${file}`);
      }
    }
  }
}
