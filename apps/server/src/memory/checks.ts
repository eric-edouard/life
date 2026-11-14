import { isEndingCheck } from "../records/fact-check";
import type { InferredPerson, Unresolved } from "../records/observation";
import { KEEP_AT } from "../records/unit";
import { pagedNow } from "./closeness";
import { guessedOf, plain } from "./doubts";
import { type MatterView, matterBookOf, matterPeopleOf } from "./matter-read";
import { mattersNow, readMatterRecords, readMatters } from "./matters";
import {
  readFactCheckAnswers,
  readFactChecks,
  readUnitsFor,
  readUnresolved,
} from "./memory-files";
import { nameKey } from "./units";
import { type People, readPeople, type Shown } from "./who";
import { dayNow } from "./zones";

// The checks: everything Life would like him to verify, in one shape and one list, with no limit. A check is one guess
// of Life's that his word would settle, shown with its evidence; it exists only while something rides on the guess (a
// kept line, an open matter, a page). Life keeps using its guess meanwhile. Derived when read, never stored: his answer
// is a correction (a person), an `outdated` word (an ending) or a fact-check answer.

type CheckKind = "ending" | "person";
/** What a check is, for counting: an ending, a guessed person, a Contacts card Life cannot place, a name it cannot place. */
type CheckGroup = "ending" | "guessed person" | "card" | "name";

export interface Check {
  /** The words of his answer that settle it, as `correct_memory` takes them. */
  answers: string[];
  /** The words the guess rests on, with where and when they were said; none for a Contacts card. */
  evidence: { from: string; quote: string } | null;
  /** The guess, in a sentence worded by a template (no model). */
  group: CheckGroup;
  guess: string;
  kind: CheckKind;
  /** An observation id (ending), a person ref (a guessed person, a card), or `name:<nameKey>` (a name not placed). */
  ref: string;
  /** What uses the guess today, counted from what is stored. */
  ridesOn: { matters: number; observations: number; pages: number };
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
  /** Refs of the old doubt lines drawn before 14 Nov 2026 (stored fact checks that are not ending checks): an answer by ref would land on them. */
  doubted: ReadonlySet<string>;
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

/** `CheckInputs` with the lookups every builder shares, made once. */
interface Ctx extends CheckInputs {
  byId: ReadonlyMap<string, Line>;
  /** The open matters holding a step, by the step's ref, and involving a person, by the person's ref. */
  mattersByPerson: ReadonlyMap<string, Set<object>>;
  mattersByStep: ReadonlyMap<string, Set<object>>;
}

function ctxOf(c: CheckInputs): Ctx {
  const mattersByStep = new Map<string, Set<object>>();
  const mattersByPerson = new Map<string, Set<object>>();
  const add = (by: Map<string, Set<object>>, ref: string, m: object) =>
    by.set(ref, (by.get(ref) ?? new Set()).add(m));
  for (const m of c.matters.filter((x) => x.open)) {
    for (const s of m.steps) {
      add(mattersByStep, s.ref, m);
    }
    for (const r of matterPeopleOf(m)) {
      add(mattersByPerson, r, m);
    }
  }
  return {
    ...c,
    byId: new Map(c.lines.map((l) => [l.id, l])),
    mattersByPerson,
    mattersByStep,
  };
}

const ANSWERS = {
  ending: ["outdated", "false"],
  person: ["this-is", "not-this-person", "same-person"],
};

/** The guess of an ending check, in one place: the builder shows it and his answer stores it. */
export const endingGuessOf = (step: string) =>
  `Life thinks this is done: ${step}`;

/** Whether an open step with an ending found is an ending check: no old doubt line holds its ref, he has not answered. */
export const isEndingOpen = (
  ref: string,
  c: Pick<CheckInputs, "answered" | "doubted">
) => !(c.doubted.has(ref) || c.answered.has(ref));

/** An ending check always has its evidence: the later step's words. */
export const isEndingKind = (
  c: Check
): c is Check & { evidence: NonNullable<Check["evidence"]> } =>
  c.kind === "ending";

const whereOf = (l: Line): Where => `${l.source.channel}, ${plain(l.date)}`;

/** What rides on a guess: the kept `lines` using it, the open matters holding one of them or one of `refs`, the pages they show on. */
function ridesOn(c: Ctx, lines: Line[], refs: string[]) {
  const matters = new Set([
    ...lines.flatMap((l) => [...(c.mattersByStep.get(l.id) ?? [])]),
    ...refs.flatMap((r) => [...(c.mattersByPerson.get(r) ?? [])]),
  ]);
  const shownOn = new Set(
    [...refs, ...lines.flatMap((l) => [l.about ?? "", ...l.subjects])].map(
      c.people.refOf
    )
  );
  return {
    matters: matters.size,
    observations: lines.filter((l) => c.kept.has(l.id)).length,
    pages: [...shownOn].filter((r) => c.paged.has(r)).length,
  };
}

/** The kept lines each ref in `refsOf(line)` appears in. */
const keptBy = (c: Ctx, refsOf: (l: Line) => string[]) => {
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
  c: Ctx,
  group: CheckGroup,
  fields: Pick<Check, "guess" | "ref">,
  lines: Line[],
  refs: string[],
  evidence: { quote: string; where?: Where } | null
): Ranked[] {
  const rides = ridesOn(c, lines, refs);
  const kind = group === "ending" ? "ending" : "person";
  return rides.matters + rides.observations > 0
    ? [
        {
          check: {
            answers: ANSWERS[kind],
            evidence: evidence && {
              from: evidence.where ?? "an earlier message",
              quote: evidence.quote,
            },
            group,
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

/** Each kind of check, from what is stored. A new kind (a voice, a tie, an appointment, a line with a doubt of its own) is one more entry. */
const BUILDERS: Record<CheckKind, (c: Ctx) => Ranked[]> = {
  /** Every open step a link says ended and he has not answered. */
  ending: (c) =>
    [...c.endings].flatMap(([ref, link]) => {
      const o = c.byId.get(ref);
      const later = c.byId.get(link.later);
      return o && isEndingOpen(ref, c)
        ? ranked(c, "ending", { guess: endingGuessOf(o.text), ref }, [o], [], {
            quote: link.quote,
            where: later ? whereOf(later) : c.where.get(link.later),
          })
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
            "guessed person",
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
        "card",
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
      const lines = [...new Set(rows.map((r) => r.observation))].flatMap(
        (id) => {
          const l = id ? c.byId.get(id) : undefined;
          return l && c.kept.has(l.id) ? [l] : [];
        }
      );
      const last = lines.length > 0 ? newest(lines) : undefined;
      return ranked(
        c,
        "name",
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
export const checksOf = (inputs: CheckInputs): Check[] => {
  const c = ctxOf(inputs);
  return Object.values(BUILDERS)
    .flatMap((build) => build(c))
    .toSorted(
      (a, b) =>
        b.check.ridesOn.matters - a.check.ridesOn.matters ||
        b.check.ridesOn.observations - a.check.ridesOn.observations ||
        b.check.ridesOn.pages - a.check.ridesOn.pages ||
        b.day.localeCompare(a.day) ||
        a.check.ref.localeCompare(b.check.ref)
    )
    .map((r) => r.check);
};

/** What Life would like him to verify now, over what is stored today: read-only, no model call. */
export async function checksNow(): Promise<Check[]> {
  const people = await readPeople();
  const [records, unresolved, paged] = await Promise.all([
    readMatterRecords(people),
    readUnresolved(),
    pagedNow(people),
  ]);
  const matters = matterBookOf(
    mattersNow(readMatters()).matters,
    records,
    dayNow()
  );
  const units = readUnitsFor(
    people.inferred.flatMap((p) => p.evidence.map((e) => e.unit))
  );
  return checksOf({
    answered: new Set(
      [...readFactCheckAnswers()].flatMap(([ref, a]) => (a.answer ? [ref] : []))
    ),
    doubted: new Set(
      readFactChecks()
        .filter((s) => !isEndingCheck(s))
        .map((s) => s.ref)
    ),
    endings: records.maybe,
    // Kept: shown, not retired, at or above KEEP_AT (what `observationStatusOf` calls active).
    kept: new Set(
      records.observations
        .filter((o) => o.importance >= KEEP_AT && !records.endings.has(o.id))
        .map((o) => o.id)
    ),
    lines: records.observations,
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

const BIG = 5;
/** How many ride on an open matter, and of the rest on one line, two to five, more than five. */
const spread = (list: Check[]) => {
  const rest = list.filter((c) => c.ridesOn.matters === 0);
  const lines = (from: number, to: number) =>
    rest.filter(
      (c) => c.ridesOn.observations >= from && c.ridesOn.observations <= to
    ).length;
  return `Riding on: ${list.length - rest.length} on an open matter; of the other ${rest.length}, ${lines(1, 1)} on 1 line, ${lines(2, BIG)} on 2 to ${BIG} lines, ${lines(BIG + 1, Number.POSITIVE_INFINITY)} on more than ${BIG}.`;
};

/** `bun life memory checks`: the count by kind and by what rides, then every row, most load-bearing first. */
export function checksText(list: Check[]) {
  const groups = Map.groupBy(list, (c) => c.group);
  return [
    `${list.length} checks: ${[...groups].map(([g, l]) => `${l.length} ${g}`).join(", ") || "none"}.`,
    spread(list),
    "",
    ...list.flatMap((c, i) => [
      `${i + 1}. [${c.group}] ${c.guess}`,
      ...(c.evidence ? [`   "${c.evidence.quote}" (${c.evidence.from})`] : []),
      `   rides on: ${c.ridesOn.observations} lines, ${c.ridesOn.matters} open matters, ${c.ridesOn.pages} pages. His answer: ${c.answers.join(" | ")}`,
      "",
    ]),
  ].join("\n");
}
