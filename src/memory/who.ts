import {
  type Correction,
  INFERRED_USE_AT,
  type InferredPerson,
  type Observation,
  type Person,
  type Unresolved,
} from "../schema";
import { handleIndex, loadTruth } from "../truth";
import {
  readCorrections,
  readInferred,
  readObservations,
  readStanding,
  readUnresolved,
  shownOf,
} from "./ledger";
import { nameIndex, normalize, personRef } from "./units";

// Who a name, handle or person ref is now: truth/, the people Life inferred and the owner's corrections, in that order
// of trust under his word. Every reader and step resolves people through here.

export const UNKNOWN = "unknown:";

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
  corrections: Correction[]
) {
  const canon = merged(corrections);
  const resolve = resolver(people, inferred, corrections);
  const found = unresolved.flatMap((u) =>
    u.observation
      ? [{ observation: u.observation, ref: resolve(u.surface) }]
      : []
  );
  const named = Map.groupBy(found, (n) => n.observation);
  return observations.map((o) => {
    const spoke = o.speaker.startsWith(UNKNOWN)
      ? resolve(o.speaker.slice(UNKNOWN.length))
      : null;
    return {
      ...o,
      entities: [
        ...new Set([
          ...o.entities.map(canon),
          ...(named.get(o.id) ?? []).flatMap((n) => (n.ref ? [n.ref] : [])),
          ...(spoke ? [spoke] : []),
        ]),
      ].sort(),
      unmapped: !!named.get(o.id)?.some((n) => !n.ref),
    };
  });
}

/** truth/, Life's inferred people and the owner's corrections, read once, with the resolver and the folds over them. */
export async function readPeople() {
  const [truth, inferred, corrections] = await Promise.all([
    loadTruth(),
    readInferred(),
    readCorrections(),
  ]);
  const canon = merged(corrections);
  const resolve = resolver(truth.people, inferred, corrections);
  return {
    canon,
    corrections,
    inferred,
    /** A readable name for each person (inferred ones too), project and area ref. */
    names: new Map<string, string>([
      ...[...truth.people, ...inferred].map(
        (p) => [`person:${p.id}`, p.name] as const
      ),
      ...truth.projects.map((p) => [`project:${p.id}`, p.name] as const),
      ...truth.areas.map((a) => [`area:${a.id}`, a.name] as const),
    ]),
    /** Who a moment's person ref is as of today: a name since resolved, a person since folded into another. */
    refOf: (ref: string) =>
      ref.startsWith(UNKNOWN)
        ? (resolve(ref.slice(UNKNOWN.length)) ?? ref)
        : canon(ref),
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
  const [all, standing, unresolved] = await Promise.all([
    read,
    readStanding(corrections, read),
    readUnresolved(),
  ]);
  const observations = aboutNow(
    shownOf(all, standing),
    unresolved,
    truth.people,
    inferred,
    corrections
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
