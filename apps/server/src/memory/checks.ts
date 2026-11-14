import type { InferredPerson, Unresolved } from "../records/observation";
import { KEEP_AT } from "../records/unit";
import { pagedNow } from "./closeness";
import { doubtsOf, guessedOf, plain } from "./doubts";
import type { MatterView } from "./matter-read";
import { readMatterBook, readMatterRecords } from "./matters";
import {
  observationStatusOf,
  readFactCheckAnswers,
  readUnitsFor,
  readUnresolved,
} from "./memory-files";
import { nameKey } from "./units";
import { observationsNow, type People, readPeople, type Shown } from "./who";
import { dayNow } from "./zones";

// The checks: everything Life would like him to verify, in one shape and one list, with no limit. A check is one guess
// of Life's that his word would settle, shown with its evidence; it exists only while something rides on the guess (a
// kept line, an open matter, a page). Life keeps using its guess meanwhile. Derived when read, never stored: his answer
// is a correction (a person), an `outdated` word (an ending) or a fact-check answer.

export type CheckKind = "ending" | "person" | "fact";

export interface Check {
  /** The words of his answer that settle it, as `correct_memory` takes them. */
  answers: string[];
  /** The words the guess rests on, with where and when they were said; none for a Contacts card. */
  evidence: { from: string; quote: string } | null;
  /** The guess, in a sentence worded by a template (no model). */
  guess: string;
  kind: CheckKind;
  /** An observation id (ending, fact), a person ref (a guessed person, a card), or `name:<nameKey>` (a name not placed). */
  ref: string;
  /** What uses the guess today, counted from what is stored. */
  ridesOn: { matters: number; observations: number; summaries: number };
}

/** A kept line as the checks read it. */
type Line = Pick<
  Shown,
  | "about"
  | "confidence"
  | "date"
  | "id"
  | "quote"
  | "subjects"
  | "text"
  | "unit"
> & { source: Pick<Shown["source"], "channel"> };

/** Where and when a record was said, in words: "whatsapp, 7 Sep". */
type Where = string;

/** Everything the checks are worked out from; `checksNow` reads it, `checksOf` is pure over it. */
export interface CheckInputs {
  /** Refs of the fact-check answers he gave (any answer settles that line's check). */
  answered: ReadonlySet<string>;
  /** Each open step a link says ended, not yet his word (`endingsRead`). */
  endings: ReadonlyMap<string, { later: string; quote: string }>;
  /** Every observation that shows, and the ids of those that are kept: active, at or above `KEEP_AT`. */
  kept: ReadonlySet<string>;
  lines: readonly Line[];
  matters: readonly (Pick<
    MatterView,
    "open" | "owedTo" | "told" | "waitingOn" | "with"
  > & {
    steps: { ref: string }[];
  })[];
  paged: ReadonlySet<string>;
  people: Pick<
    People,
    "ambiguousCards" | "isGuess" | "names" | "refOf" | "resolve"
  > & {
    inferred: Pick<
      InferredPerson,
      | "at"
      | "confidence"
      | "evidence"
      | "id"
      | "name"
      | "namesAndHandles"
      | "relation"
    >[];
  };
  unresolved: readonly Pick<Unresolved, "nameAsWritten" | "observation">[];
  /** Where a record that is not a line was said: units and episodes, by id. */
  where: ReadonlyMap<string, Where>;
}

interface Ranked {
  check: Check;
  /** The newest day among the lines it rides on, for the order. */
  day: string;
}

const ANSWERS = {
  ending: ["outdated", "false"],
  fact: ["true", "partly", "false", "outdated"],
  person: ["this-is", "not-this-person", "same-person"],
};

const whereOf = (l: Line): Where => `${l.source.channel}, ${plain(l.date)}`;

/** What rides on a guess: the kept `lines` using it, the open matters holding one of them or one of `refs`, the pages they show on. */
function ridesOn(c: CheckInputs, lines: Line[], refs: string[]) {
  const ids = new Set(lines.map((l) => l.id));
  const people = new Set(refs);
  const shownOn = new Set(
    [...refs, ...lines.flatMap((l) => [l.about ?? "", ...l.subjects])].map(
      c.people.refOf
    )
  );
  return {
    matters: c.matters.filter(
      (m) =>
        m.open &&
        (m.steps.some((s) => ids.has(s.ref)) ||
          [...m.with, ...m.owedTo, ...m.waitingOn, ...m.told].some((r) =>
            people.has(r)
          ))
    ).length,
    observations: lines.filter((l) => c.kept.has(l.id)).length,
    summaries: [...shownOn].filter((r) => c.paged.has(r)).length,
  };
}

/** The kept lines each ref in `refsOf(line)` appears in. */
const keptBy = (c: CheckInputs, refsOf: (l: Line) => string[]) => {
  const by = new Map<string, Line[]>();
  for (const l of c.lines) {
    for (const ref of c.kept.has(l.id) ? refsOf(l) : []) {
      by.set(ref, [...(by.get(ref) ?? []), l]);
    }
  }
  return by;
};

const newest = (lines: Line[]) =>
  lines.reduce((m, l) => (l.date > m.date ? l : m));

function ranked(
  c: CheckInputs,
  kind: CheckKind,
  fields: Pick<Check, "guess" | "ref"> & { answers?: string[] },
  lines: Line[],
  refs: string[],
  evidence: { quote: string; where?: Where } | null
): Ranked[] {
  const rides = ridesOn(c, lines, refs);
  return rides.matters + rides.observations > 0
    ? [
        {
          check: {
            answers: fields.answers ?? ANSWERS[kind],
            evidence: evidence && {
              from: evidence.where ?? "an earlier message",
              quote: evidence.quote,
            },
            guess: fields.guess,
            kind,
            ref: fields.ref,
            ridesOn: rides,
          },
          day: lines.reduce((m, l) => (l.date > m ? l.date : m), ""),
        },
      ]
    : [];
}

/** Each kind of check, from what is stored. A new kind (a voice, a tie, an appointment) is one more entry. */
export const BUILDERS: Record<CheckKind, (c: CheckInputs) => Ranked[]> = {
  /** Every open step a link says ended and he has not answered. */
  ending: (c) => {
    const byId = new Map(c.lines.map((l) => [l.id, l]));
    return [...c.endings].flatMap(([ref, link]) => {
      const o = byId.get(ref);
      const later = byId.get(link.later);
      return o && !c.answered.has(ref)
        ? ranked(
            c,
            "ending",
            { guess: `Life thinks this is done: ${o.text}`, ref },
            [o],
            [],
            {
              quote: link.quote,
              where: later ? whereOf(later) : c.where.get(link.later),
            }
          )
        : [];
    });
  },
  /** A line with a doubt of its own (not its guessed person: that is the person's check). None exists yet. */
  fact: (c) =>
    c.lines.flatMap((l) => {
      const doubts = c.kept.has(l.id) ? doubtsOf(l, c.people) : [];
      return doubts.length > 0 &&
        !doubts.includes("guessed-person") &&
        !c.answered.has(l.id)
        ? ranked(
            c,
            "fact",
            { guess: `Life is unsure of this line: ${l.text}`, ref: l.id },
            [l],
            [],
            { quote: l.quote, where: whereOf(l) }
          )
        : [];
    }),
  /** The three guesses about who someone is: a guessed person, a Contacts card Life cannot place, a name it cannot place. */
  person: (c) => {
    const { people } = c;
    const byGuess = keptBy(c, (l) => guessedOf(l, people));
    const guessed = [
      ...new Map(people.inferred.map((p) => [p.id, p])).values(),
    ].flatMap((p) => {
      const ref = `person:${p.id}`;
      const [first] = p.evidence;
      const where = first && c.where.get(first.unit);
      return people.isGuess(ref)
        ? ranked(
            c,
            "person",
            {
              guess: `Life guesses ${p.namesAndHandles.join(" / ")} is ${p.name}, ${p.relation} (${Math.round(p.confidence * 100)}% sure).`,
              ref,
            },
            byGuess.get(ref) ?? [],
            [ref],
            first ? { quote: first.quote, where } : null
          )
        : [];
    });
    const byRef = keptBy(c, (l) =>
      [l.about ?? "", ...l.subjects].map(people.refOf)
    );
    const cards = people.ambiguousCards.flatMap((a) =>
      ranked(
        c,
        "person",
        {
          guess: `Life cannot place the Contacts card ${people.names.get(a.card) ?? a.card}: its name and handles say ${a.people.map((p) => people.names.get(p) ?? p).join(" and ")}.`,
          ref: a.card,
        },
        byRef.get(a.card) ?? [],
        [a.card],
        null
      )
    );
    const open = c.unresolved.filter(
      (r) => r.observation && !people.resolve(r.nameAsWritten)
    );
    const names = [
      ...Map.groupBy(open, (r) => nameKey(r.nameAsWritten) || r.nameAsWritten),
    ].flatMap(([key, rows]) => {
      const ids = new Set(rows.map((r) => r.observation));
      const lines = c.lines.filter((l) => ids.has(l.id) && c.kept.has(l.id));
      const last = lines.length > 0 ? newest(lines) : undefined;
      return ranked(
        c,
        "person",
        {
          guess: `Life cannot tell who "${[...new Set(rows.map((r) => r.nameAsWritten))].join(" / ")}" is.`,
          ref: `name:${key}`,
        },
        lines,
        [],
        last ? { quote: last.quote, where: whereOf(last) } : null
      );
    });
    return [...guessed, ...cards, ...names];
  },
};

/** The checks, most load-bearing first: matters, then lines, then pages, then newest. Pure over what is stored. */
export const checksOf = (c: CheckInputs): Check[] =>
  Object.values(BUILDERS)
    .flatMap((build) => build(c))
    .toSorted(
      (a, b) =>
        b.check.ridesOn.matters - a.check.ridesOn.matters ||
        b.check.ridesOn.observations - a.check.ridesOn.observations ||
        b.check.ridesOn.summaries - a.check.ridesOn.summaries ||
        b.day.localeCompare(a.day) ||
        a.check.ref.localeCompare(b.check.ref)
    )
    .map((r) => r.check);

/** What Life would like him to verify now, over what is stored today: read-only, no model call. */
export async function checksNow(): Promise<Check[]> {
  const people = await readPeople();
  const today = dayNow();
  const [{ observations, statusInputs }, records, matters, paged] =
    await Promise.all([
      observationsNow(people),
      readMatterRecords(people),
      readMatterBook(people, today),
      pagedNow(people),
    ]);
  const unresolved = await readUnresolved();
  const evidence = people.inferred.flatMap((p) =>
    p.evidence.map((e) => e.unit)
  );
  const units = readUnitsFor(evidence);
  return checksOf({
    answered: new Set(
      [...readFactCheckAnswers()].flatMap(([ref, a]) => (a.answer ? [ref] : []))
    ),
    endings: records.maybe,
    kept: new Set(
      observations
        .filter(
          (o) =>
            o.importance >= KEEP_AT &&
            observationStatusOf(o, statusInputs).state === "active"
        )
        .map((o) => o.id)
    ),
    lines: observations,
    matters,
    paged,
    people,
    unresolved,
    where: new Map([
      ...units.map((u): [string, Where] => [
        u.id,
        `${u.source}, ${plain(u.date)}`,
      ]),
      ...records.episodes.map((m): [string, Where] => [
        m.id,
        `an episode, ${plain(m.day)}`,
      ]),
    ]),
  });
}

/** The group a check is counted in: an ending, a guessed person, a Contacts card, a name, a fact. */
export function groupOf(c: Check) {
  if (c.kind !== "person") {
    return c.kind;
  }
  if (c.ref.startsWith("name:")) {
    return "name";
  }
  return c.ref.startsWith("person:con_") ? "card" : "guessed person";
}

const BIG = 5;
/** How many ride on an open matter, else on one line, two to five, more than five. */
const spread = (list: Check[]) => {
  const rest = list.filter((c) => c.ridesOn.matters === 0);
  return {
    "1 line": rest.filter((c) => c.ridesOn.observations === 1).length,
    "2 to 5 lines": rest.filter(
      (c) => c.ridesOn.observations >= 2 && c.ridesOn.observations <= BIG
    ).length,
    "an open matter": list.length - rest.length,
    "more than 5 lines": rest.filter((c) => c.ridesOn.observations > BIG)
      .length,
  };
};

const count = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");

/** `bun life memory checks`: the count by kind and by what rides, then every row, most load-bearing first. */
export function checksText(list: Check[]) {
  const kinds: Record<string, number> = {};
  for (const c of list) {
    kinds[groupOf(c)] = (kinds[groupOf(c)] ?? 0) + 1;
  }
  return [
    `${list.length} checks: ${count(kinds) || "none"}.`,
    `Riding on: ${count(spread(list))}.`,
    "",
    ...list.flatMap((c, i) => [
      `${i + 1}. [${groupOf(c)}] ${c.guess}`,
      ...(c.evidence ? [`   "${c.evidence.quote}" (${c.evidence.from})`] : []),
      `   rides on: ${c.ridesOn.observations} lines, ${c.ridesOn.matters} open matters, ${c.ridesOn.summaries} pages. His answer: ${c.answers.join(" | ")}`,
      "",
    ]),
  ].join("\n");
}
