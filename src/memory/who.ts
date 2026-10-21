import {
  type Correction,
  INFERRED_USE_AT,
  type InferredPerson,
  type Observation,
  type Person,
  type Unit,
  type Unresolved,
} from "../schema";
import { sourceOf } from "../sources";
import { handleIndex, loadTruth, OWNER } from "../truth";
import {
  readCorrections,
  readInferred,
  readObservations,
  readStanding,
  readUnits,
  readUnresolved,
  shownOf,
} from "./ledger";
import { nameIndex, normalize, personRef } from "./units";

// Who a name, handle or person ref is now: truth/, the people Life inferred and the owner's corrections, in that order
// of trust under his word. Every reader and step resolves people through here.

export const UNKNOWN = "unknown:";

const WHO = /^(person|unknown):/;
/** A speaker as a reader sees it: the readable name when there is one, else the id without its `person:` prefix. */
export const who = (x: { speaker: string; speakerName?: string }) =>
  x.speakerName ?? x.speaker.replace(WHO, "");

/** Follows the owner's `same-person` corrections: a person ref folded into another becomes that one. */
export function merged(corrections: Correction[]) {
  const into = new Map<string, string>();
  for (const c of corrections) {
    if (c.kind === "same-person") {
      into.set(c.from, c.to);
    }
  }
  return (ref: string) => {
    let r = ref;
    // At most one hop per correction, so a loop in the corrections cannot spin.
    for (let i = 0; i < into.size && into.has(r); i += 1) {
      r = into.get(r) ?? r;
    }
    return r;
  };
}

/**
 * Maps a name, handle or address to `person:<slug>`, in this order: what the owner said it is (`this-is`), `truth/`
 * (handles, then names and aliases), then the people Life inferred. A `not-this-person` correction blocks that match;
 * a `same-person` one folds the result into the other person.
 */
export function resolver(
  people: Person[],
  inferred: InferredPerson[] = [],
  corrections: Correction[] = []
) {
  const handles = handleIndex(people);
  const names = nameIndex(people);
  const canon = merged(corrections);
  const keys = (s: string) =>
    [s.trim(), s.trim().toLowerCase(), normalize(s)].filter(Boolean);
  const said = new Map<string, string>();
  const not = new Set<string>();
  for (const c of corrections) {
    for (const k of c.kind === "this-is" || c.kind === "not-this-person"
      ? keys(c.surface)
      : []) {
      if (c.kind === "this-is") {
        said.set(k, c.person);
      } else if (c.kind === "not-this-person") {
        not.add(`${k}|${c.person}`);
      }
    }
  }
  const guessed = new Map<string, string>();
  for (const r of inferred) {
    for (const k of r.surfaces.flatMap(keys)) {
      if (r.confidence >= INFERRED_USE_AT) {
        guessed.set(k, `person:${r.id}`);
      }
    }
  }
  return (surface: string): string | null => {
    const ks = keys(surface);
    const truth = handles.get(ks[0] ?? "") ?? handles.get(ks[1] ?? "");
    const named = personRef(surface.trim(), names);
    const ref = [
      ...ks.map((k) => said.get(k)),
      truth && `person:${truth}`,
      named.startsWith("person:") ? named : undefined,
      ...ks.map((k) => guessed.get(k)),
    ].find((r) => r && !ks.some((k) => not.has(`${k}|${r}`)));
    return ref ? canon(ref) : null;
  };
}

/**
 * What each observation is about today: the entities it was filed with, plus the names Life could not map when it was
 * read and can now, with the owner's same-person folds applied; `unmapped` when it still names someone Life cannot map.
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
  const canon = merged(corrections);
  const resolve = resolver(people, inferred, corrections);
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

/** An observation as readers get it (`aboutNow`). */
export type Shown = ReturnType<typeof aboutNow>[number];

/** truth/, Life's inferred people and the owner's corrections, read once, with the resolver and the folds over them. */
export async function readPeople() {
  const [truth, inferred, corrections] = await Promise.all([
    loadTruth(),
    readInferred(),
    readCorrections(),
  ]);
  const canon = merged(corrections);
  const resolve = resolver(truth.people, inferred, corrections);
  /** Who a moment's person ref is as of today. */
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
    /** A moment's person ref as a reader sees it: the readable name of who it is today, else the bare id. */
    nameOf: (ref: string) =>
      names.get(refOf(ref)) ?? who({ speaker: refOf(ref) }),
    /** A readable name for each person (inferred ones too), project and area ref. */
    names,
    /** Who a moment's person ref is as of today: a name since resolved, a person since folded into another. */
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

const PERSON = /^person:/;

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
