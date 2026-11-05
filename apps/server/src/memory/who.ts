import {
  type Correction,
  INFERRED_USE_AT,
  type InferredPerson,
  type Observation,
  type Unresolved,
} from "../records/observation";
import type { Person } from "../records/truth";
import type { Unit } from "../records/unit";
import {
  readCorrections,
  readInferred,
  readObservations,
  readStanding,
  readUnits,
  readUnresolved,
  shownOf,
} from "./ledger";
import { handlesOf, loadTruth, OWNER } from "./read-truth";
import { kindOf, sourceOf } from "./sources";
import { normalize, PERSON, UNKNOWN } from "./units";

// Who a name, handle or person ref is now: truth/, the people Life inferred and the owner's corrections, in that order
// of trust under his word. Every reader and step resolves people through here.

const WHO = /^(person|unknown):/;
/** A speaker as a reader sees it: the readable name when there is one, else the id without its `person:` prefix. */
export const who = (x: { speaker: string; speakerName?: string }) =>
  x.speakerName ?? x.speaker.replace(WHO, "");

/** A surface's lookup keys: as given, lowercased, normalized. */
const keysOf = (s: string) =>
  [s.trim(), s.trim().toLowerCase(), normalize(s)].filter(Boolean);

/** Each surface key's inferred person: the latest record at or above INFERRED_USE_AT decides. */
function guessesOf(inferred: InferredPerson[]) {
  const guessed = new Map<string, InferredPerson>();
  for (const r of inferred) {
    for (const k of r.confidence >= INFERRED_USE_AT
      ? r.surfaces.flatMap(keysOf)
      : []) {
      guessed.set(k, r);
    }
  }
  return guessed;
}

const PAREN = /\(.*?\)/g;

/** Names and aliases on the map, normalized, to the person; a name two people share maps to nobody. */
function nameIndex(people: Person[]) {
  const index = new Map<string, string | null>();
  for (const p of people) {
    for (const n of [p.name, ...p.aliases]) {
      const k = normalize(n);
      index.set(k, index.has(k) && index.get(k) !== p.id ? null : p.id);
    }
  }
  return index;
}

/** Index of every handle in the map to the person who owns it. */
const handleIndex = (people: Person[]): Map<string, string> =>
  new Map(people.flatMap((p) => handlesOf(p).map((h) => [h, p.id])));

/**
 * Who a name, handle or address reads as, before folds, in this order: what the owner said it is (`this-is`), `truth/`
 * (handles, then names and aliases), then its latest confident inferred guess (the person in truth/ it links to, else
 * the guess). A `not-this-person` correction blocks that match.
 */
function readingOf(
  people: Person[],
  inferred: InferredPerson[],
  corrections: Correction[]
) {
  const handles = handleIndex(people);
  const names = nameIndex(people);
  const said = new Map<string, string>();
  const not = new Set<string>();
  for (const c of corrections) {
    for (const k of c.kind === "this-is" || c.kind === "not-this-person"
      ? keysOf(c.surface)
      : []) {
      if (c.kind === "this-is") {
        said.set(k, c.person);
      } else if (c.kind === "not-this-person") {
        not.add(`${k}|${c.person}`);
      }
    }
  }
  const guessed = guessesOf(inferred);
  return (surface: string): string | null => {
    const ks = keysOf(surface);
    const truth = handles.get(ks[0] ?? "") ?? handles.get(ks[1] ?? "");
    // A name as lifelog gives it, its parentheses left out ("Jean (Me)").
    const named = names.get(normalize(surface.trim().replace(PAREN, "")));
    const guesses = ks.map((k) => guessed.get(k));
    return (
      [
        ...ks.map((k) => said.get(k)),
        truth && `person:${truth}`,
        named && `person:${named}`,
        ...guesses.map((g) => g?.person),
        ...guesses.map((g) => g && `person:${g.id}`),
      ].find((r) => r && !ks.some((k) => not.has(`${k}|${r}`))) ?? null
    );
  };
}

/**
 * Who a surface and a person ref are now: `resolve` is what a surface reads as (`readingOf`), folded; `canon` folds a
 * ref, his `same-person` over what each inferred id's surface reads as now, so every id a surface was ever given is
 * the one person it reads as.
 */
export function foldsOf(
  people: Person[],
  inferred: InferredPerson[],
  corrections: Correction[]
) {
  const read = readingOf(people, inferred, corrections);
  const into = new Map<string, string>();
  for (const r of inferred) {
    const self = `person:${r.id}`;
    const to = r.surfaces.map(read).find((x) => x && x !== self);
    if (to) {
      into.set(self, to);
    }
  }
  for (const c of corrections) {
    if (c.kind === "same-person") {
      into.set(c.from, c.to);
    }
  }
  const canon = (ref: string) => {
    let r = ref;
    // At most one hop per fold, so a loop cannot spin.
    for (let i = 0; i < into.size && into.has(r); i += 1) {
      r = into.get(r) ?? r;
    }
    return r;
  };
  const resolve = (surface: string): string | null => {
    const ref = read(surface);
    return ref ? canon(ref) : null;
  };
  return { canon, resolve };
}

/**
 * What each observation is about today: the entities it was filed with, plus the names Life could not map when it was
 * read and can now, folded (`foldsOf`); `unmapped` when it still names someone Life cannot map.
 * The pages and the search index both go by this.
 */
export function aboutNow(
  observations: Observation[],
  unresolved: Unresolved[],
  people: Person[],
  inferred: InferredPerson[],
  corrections: Correction[],
  chatOf: Map<string, string> = new Map()
) {
  const { canon, resolve } = foldsOf(people, inferred, corrections);
  const found = unresolved.flatMap((u) =>
    u.observation
      ? [{ observation: u.observation, ref: resolve(u.surface) }]
      : []
  );
  const named = Map.groupBy(found, (n) => n.observation);
  const namesOf = new Map<string, string[]>([
    ...inferred.map((p): [string, string[]] => [`person:${p.id}`, [p.name]]),
    ...people.map((p): [string, string[]] => [
      `person:${p.id}`,
      [p.name, ...p.aliases],
    ]),
  ]);
  // Who wrote each fact, then and now: resolved today from where they came from. The one place an author is decided.
  const authors = observations.map((o) => {
    const was = canon(o.speaker);
    const unknown = was.startsWith(UNKNOWN);
    const from = authorFrom(o, chatOf);
    // A voice keeps lifelog's id, which the map may not know: then, for an unknown one, the name lifelog gave it.
    const now =
      (from && resolve(from)) ||
      (unknown && resolve(was.slice(UNKNOWN.length))) ||
      was;
    return { now, unit: o.unit, unknown, was };
  });
  // A person an author was filed as is someone else in every fact of the unit, whoever wrote it, when every author
  // filed as them now is that one person: never the owner, nor someone who still writes in the unit as themself.
  const moves = new Map<string, Map<string, string>>();
  for (const [key, group] of Map.groupBy(
    authors.filter((a) => !a.unknown && a.was !== OWNER),
    (a) => `${a.unit}|${a.was}`
  )) {
    const now = new Set(group.map((a) => a.now));
    const [first] = group;
    if (first && now.size === 1 && !now.has(first.was)) {
      const unit = key.slice(0, key.indexOf("|"));
      moves.set(unit, (moves.get(unit) ?? new Map()).set(first.was, first.now));
    }
  }
  return observations.map((o, k) => {
    const a = authors[k] as (typeof authors)[number];
    const moved = moves.get(o.unit) ?? new Map<string, string>();
    const resolvedNow = a.unknown && a.now !== a.was;
    const entities = [
      ...new Set([
        ...o.entities.map(canon).map((e) => moved.get(e) ?? e),
        ...(named.get(o.id) ?? []).flatMap((n) => (n.ref ? [n.ref] : [])),
        ...(resolvedNow ? [a.now] : []),
      ]),
    ].sort();
    return {
      ...o,
      entities,
      // Who it is about changed since it was written (a move, a fold, a name resolved since): a page it lands on
      // has not read it (`pages.ts` offers it once).
      refiled: entities.join() !== o.entities.toSorted().join(),
      speaker: a.now,
      // A chat title named an unknown author; once they resolve, their name is the map's.
      speakerName: resolvedNow ? undefined : o.speakerName,
      // ponytail: a sentence written before tokens names people; a move swaps their names in it as it is read (never
      // stored). Tokenized sentences (extract v6) will make this a no-op for new facts.
      text: [...moved].reduce(
        (t, [was, now]) =>
          renamed(t, namesOf.get(was) ?? [], namesOf.get(now)?.[0] ?? now),
        o.text
      ),
      unmapped: !!named.get(o.id)?.some((n) => !n.ref),
    };
  });
}

/**
 * The handle or name a fact's author came from: the one it kept (`speakerFrom`), an unknown author's label, or for a
 * fact from before `speakerFrom`, its 1:1 chat's handle (`chatHandles`); none for the owner.
 */
export function authorFrom(o: Observation, chatOf: Map<string, string>) {
  if (o.speakerFrom) {
    return o.speakerFrom;
  }
  if (o.speaker.startsWith(UNKNOWN)) {
    return o.speaker.slice(UNKNOWN.length);
  }
  return o.speaker === OWNER ? undefined : chatOf.get(o.unit);
}

/** Words of a text, as `namedIn` reads names out of it. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * The people and projects `texts` name: each run of one to three words that `resolve` knows (a name, alias or surface)
 * or that is a project's name. What a call involves beyond its people (`involvedOf`); a word that is also a name only
 * adds a map entry to the call's input.
 */
export function namedIn(
  texts: string[],
  resolve: (surface: string) => string | null,
  projects: { name: string; ref: string }[]
) {
  const projectNamed = new Map(projects.map((p) => [normalize(p.name), p.ref]));
  const found = new Set<string>();
  for (const words of texts.map((t) => t.match(WORD) ?? [])) {
    for (const [i] of words.entries()) {
      for (let n = 1; n <= 3 && i + n <= words.length; n += 1) {
        const s = words.slice(i, i + n).join(" ");
        const ref = resolve(s) ?? projectNamed.get(normalize(s));
        if (ref) {
          found.add(ref);
        }
      }
    }
  }
  return found;
}

/** `text` with each whole-word `names` (any case) replaced by `name`. */
export function renamed(text: string, names: string[], name: string) {
  return names
    .filter(Boolean)
    .toSorted((a, b) => b.length - a.length)
    .reduce(
      (t, n) =>
        t.replace(
          new RegExp(
            `(?<![\\p{L}\\p{N}])${RegExp.escape(n)}(?![\\p{L}\\p{N}])`,
            "giu"
          ),
          name
        ),
      text
    );
}

/**
 * The handle of each 1:1 chat unit, by unit id (its source's `handleOf` its key): who wrote a fact that predates
 * `speakerFrom`, other than the owner. Groups, and sources whose keys hold no handle, have none.
 */
export function chatHandles(units: Unit[]) {
  return new Map(
    units.flatMap((u) => {
      const handle = sourceOf(u.source).handleOf?.(u.key);
      return handle ? [[u.id, handle] as const] : [];
    })
  );
}

/**
 * A unit as every reader of its people sees it today: each mapped by `refOf` (its units keep them unresolved), a mail's
 * senders no one knows left out (lists and shops, not people).
 */
export const unitNow = <U extends Unit>(
  u: U,
  refOf: (ref: string) => string
): U => ({
  ...u,
  people: u.people
    .map(refOf)
    .filter((p) => !(p.startsWith(UNKNOWN) && kindOf(u.source) === "mail")),
});

/** An observation as readers get it (`aboutNow`). */
export type Shown = ReturnType<typeof aboutNow>[number];

/** truth/, Life's inferred people and the owner's corrections, read once, with the resolver and the folds over them. */
export async function readPeople() {
  const [truth, inferred, corrections] = await Promise.all([
    loadTruth(),
    readInferred(),
    readCorrections(),
  ]);
  const { canon, resolve } = foldsOf(truth.people, inferred, corrections);
  /** Who an episode's person ref is as of today. */
  const refOf = (ref: string) =>
    ref.startsWith(UNKNOWN)
      ? (resolve(ref.slice(UNKNOWN.length)) ?? ref)
      : canon(ref);
  const names = new Map<string, string>([
    ...[...truth.people, ...inferred].map(
      (p) => [`person:${p.id}`, p.name] as const
    ),
    ...truth.projects.map((p) => [`project:${p.id}`, p.name] as const),
    ...truth.areas.map((a) => [`area:${a.id}`, a.name] as const),
  ]);
  return {
    canon,
    corrections,
    inferred,
    /** An episode's person ref as a reader sees it: the readable name of who it is today, else the bare id. */
    nameOf: (ref: string) =>
      names.get(refOf(ref)) ?? who({ speaker: refOf(ref) }),
    /** A readable name for each person (inferred ones too), project and area ref. */
    names,
    /** Who an episode's person ref is as of today: a name since resolved, a person since folded into another. */
    refOf,
    resolve,
    truth,
  };
}
export type People = Awaited<ReturnType<typeof readPeople>>;

/**
 * The observations the pages and the index go by, those that show (`stateOf`: neither hidden everywhere nor replaced),
 * filed as they read today; with the ledgers that say where each stands, and every observation in the ledger.
 */
export async function observationsNow({
  corrections,
  inferred,
  truth,
}: People) {
  const read = readObservations();
  const [all, standing, unresolved, units] = await Promise.all([
    read,
    readStanding(corrections, read),
    readUnresolved(),
    readUnits(),
  ]);
  const observations = aboutNow(
    shownOf(all, standing),
    unresolved,
    truth.people,
    inferred,
    corrections,
    chatHandles(units)
  );
  return { all, observations, standing };
}

/** Who goes by this name (or id): the people on the map and the ones Life inferred, by name or alias. */
export function namedLike<
  T extends { aliases: string[]; id: string; name: string },
>(name: string, people: T[]) {
  return people.filter(
    (p) =>
      p.id === name ||
      [p.name, ...p.aliases].some((n) => normalize(n) === normalize(name))
  );
}

function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

/**
 * Who a name no one goes by may mean: the people whose name or alias, or one of its words, is an edit or two from it
 * (one for a name of four letters or fewer), nearest first, five at most. A misheard or misspelled name, never a guess
 * picked for the caller.
 */
export function nearNames<
  T extends { aliases: string[]; id: string; name: string },
>(name: string, people: T[]) {
  const q = normalize(name);
  const max = q.length <= 4 ? 1 : 2;
  const best = new Map<string, { d: number; p: T }>();
  for (const p of people) {
    for (const n of [p.name, ...p.aliases].map(normalize)) {
      for (const w of new Set([n, ...n.split(" ")])) {
        const d = distance(q, w);
        if (d <= max && d < (best.get(p.id)?.d ?? max + 1)) {
          best.set(p.id, { d, p });
        }
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => a.d - b.d || a.p.name.localeCompare(b.p.name))
    .slice(0, 5)
    .map(({ p }) => p);
}

/** Everyone a name can mean: the people on his map and those Life inferred (not folded into another), going by their surfaces too. */
function nameable({
  canon,
  inferred,
  truth,
}: Pick<People, "canon" | "inferred" | "truth">) {
  return [
    ...truth.people,
    ...new Map(
      inferred
        .filter((p) => canon(`person:${p.id}`) === `person:${p.id}`)
        .map((p) => [p.id, { ...p, aliases: p.surfaces }])
    ).values(),
  ];
}

/**
 * Who a name means: who it resolves to (handles, his corrections, names), else the first person going by it; a name
 * nothing resolves means no one (never a part of a name). `same`: everyone going by it, the one meant first (listed
 * even when it goes by another name, a handle or one he said is them).
 */
export function meant(
  name: string,
  people: Pick<People, "canon" | "inferred" | "resolve" | "truth">
) {
  const all = nameable(people);
  const resolved = people.resolve(name)?.replace(PERSON, "");
  const one = all.find((p) => p.id === resolved);
  const same = namedLike(name, all).filter((p) => p.id !== resolved);
  return {
    all,
    known: resolved ?? same[0]?.id,
    same: one ? [one, ...same] : same,
  };
}
