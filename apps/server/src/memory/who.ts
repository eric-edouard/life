import {
  type Correction,
  INFERRED_PREFIX,
  INFERRED_USE_AT,
  type InferredPerson,
  type Observation,
  peopleOutsideDirectoryOf,
  type Unresolved,
  unfoldedOf,
} from "../records/observation";
import { namesOne, relationWordOf } from "../records/relation-words";
import type { TieNow } from "../records/tie";
import type { Person } from "../records/truth";
import type { Unit } from "../records/unit";
import { contactKeyOf } from "../sources/contacts";
import { type ContactNow, contactsNow } from "./contact-people";
import {
  readContactLines,
  readCorrections,
  readInferred,
  readObservationStatusInputs,
  readObservations,
  readUnitsFor,
  readUnresolved,
  shownOf,
} from "./memory-files";
import { handlesOf, loadTruth, OWNER } from "./read-truth";
import { kindOf, sourceOf } from "./sources";
import { nameKey, PERSON, UNKNOWN } from "./units";

// Who a name, handle or person ref is now: truth/, the people his Contacts name, the people Life inferred and the
// owner's corrections, in that order of trust under his word. Every reader and step resolves people through here.

const WHO = /^(person|unknown):/;
/** A speaker as a reader sees it: the readable name when there is one, else the id without its `person:` prefix. */
export const who = (x: { speaker: string; speakerName?: string }) =>
  x.speakerName ?? x.speaker.replace(WHO, "");

/** A name or handle's lookup keys: as given, lowercased, normalized. */
const keysOf = (s: string) =>
  [s.trim(), s.trim().toLowerCase(), nameKey(s)].filter(Boolean);

/** Whether two names or handles are one: a key in common, or the same phone or email however written. */
const isSameNameOrHandle = (a: string, b: string) => {
  const key = contactKeyOf(a);
  return (
    (key !== undefined && key === contactKeyOf(b)) ||
    keysOf(a).some((k) => keysOf(b).includes(k))
  );
};

/** Each name or handle key's inferred person: the latest record at or above INFERRED_USE_AT decides. */
function guessesOf(inferred: InferredPerson[]) {
  const guessed = new Map<string, InferredPerson>();
  for (const r of inferred) {
    for (const k of r.confidence >= INFERRED_USE_AT
      ? r.namesAndHandles.flatMap(keysOf)
      : []) {
      guessed.set(k, r);
    }
  }
  return guessed;
}

const PAREN = /\(.*?\)/g;

/** Names and aliases, normalized, to the person; a name two people share maps to nobody. */
function nameIndex(people: Pick<Person, "aliases" | "id" | "name">[]) {
  const index = new Map<string, string | null>();
  for (const p of people) {
    for (const n of [p.name, ...p.aliases]) {
      const k = nameKey(n);
      if (!k) {
        continue;
      }
      index.set(k, index.has(k) && index.get(k) !== p.id ? null : p.id);
    }
  }
  return index;
}

/**
 * Index of every handle in the directory to the person who owns it: as written, and a phone or an email by its Contacts key
 * too (`contactKeyOf`), so one written another way ("06 11 11 11 11", "+33611111111") still meets.
 */
const handleIndex = (people: Person[]): Map<string, string> =>
  new Map(
    people.flatMap((p) =>
      handlesOf(p).flatMap((h) => {
        const key = contactKeyOf(h);
        return key && key !== h
          ? [
              [h, p.id],
              [key, p.id],
            ]
          : [[h, p.id]];
      })
    )
  );

/**
 * The test for "this person ref (as folded today) is only a guess": an inferred person his word has not named. `this-is`
 * or `same-person` to it confirms it. A `not-this-person` refuses one name or handle of it, not the person: one that
 * holds another handle is still a guess. The one rule (`isGuess` on `readPeople`, so `guessedOf` and the person checks
 * agree).
 */
export function guessTestOf(corrections: Correction[]) {
  const said = new Set<string>();
  for (const c of corrections) {
    if (c.kind === "this-is") {
      said.add(c.person);
    } else if (c.kind === "same-person") {
      said.add(c.to);
    }
  }
  return (ref: string) =>
    ref.startsWith(`person:${INFERRED_PREFIX}`) && !said.has(ref);
}

/**
 * Who a name, handle or address reads as, before folds, in this order: what the owner said it is (`this-is`), `truth/`
 * (handles, then names and aliases), the person his Contacts name (a handle of its card, else its name when one
 * contact person alone goes by it), then its latest confident inferred guess (the person in truth/ it links to, else
 * the guess). His Contacts are his word on a number: no guess outranks a card. A `not-this-person` correction blocks
 * that match.
 */
function readingOf(
  people: Person[],
  inferred: InferredPerson[],
  corrections: Correction[],
  contacts: ContactNow[]
) {
  const handles = handleIndex(people);
  const names = nameIndex(people);
  const carded = new Map<string, string>();
  for (const c of contacts) {
    for (const key of c.handles.flatMap((s) => contactKeyOf(s) ?? keysOf(s))) {
      if (!carded.has(key)) {
        carded.set(key, c.id);
      }
    }
  }
  const cardNames = nameIndex(contacts.map((c) => ({ ...c, aliases: [] })));
  const said = new Map<string, string>();
  const not = new Set<string>();
  for (const c of corrections) {
    for (const k of c.kind === "this-is" || c.kind === "not-this-person"
      ? keysOf(c.nameOrHandle)
      : []) {
      if (c.kind === "this-is") {
        said.set(k, c.person);
      } else if (c.kind === "not-this-person") {
        not.add(`${k}|${c.person}`);
      }
    }
  }
  const guessed = guessesOf(inferred);
  return (nameOrHandle: string): string | null => {
    const ks = keysOf(nameOrHandle);
    const key = contactKeyOf(nameOrHandle);
    const truth =
      handles.get(ks[0] ?? "") ??
      handles.get(ks[1] ?? "") ??
      (key ? handles.get(key) : undefined);
    // A name as lifelog gives it, its parentheses left out ("Jean (Me)").
    const bare = nameKey(nameOrHandle.trim().replace(PAREN, ""));
    const named = bare ? names.get(bare) : undefined;
    const guesses = ks.map((k) => guessed.get(k));
    const card =
      (key ? carded.get(key) : undefined) ??
      ks.map((k) => carded.get(k)).find(Boolean) ??
      (bare ? cardNames.get(bare) : undefined);
    return (
      [
        ...ks.map((k) => said.get(k)),
        truth && `person:${truth}`,
        named && `person:${named}`,
        card && `person:${card}`,
        ...guesses.map((g) => g?.person),
        ...guesses.map((g) => g && `person:${g.id}`),
      ].find((r) => r && !ks.some((k) => not.has(`${k}|${r}`))) ?? null
    );
  };
}

/**
 * Who a name as written and a person ref are now: `resolve` is what a name as written reads as (`readingOf`), folded; `canon` folds a
 * ref, his `same-person` over what each inferred id's name as written reads as now, so every id a name as written was ever given is
 * the one person it reads as. A contact person folds too: into whoever its whole name is in truth/, else by a handle
 * it shares with someone, else by its name (`namesTheSame`); and a guess made for one of its handles is the contact
 * person. A card whose whole name and whose handles say more than one person folds into no one (an ambiguous card: his to say).
 */
export function foldsOf(
  people: Person[],
  inferred: InferredPerson[],
  corrections: Correction[],
  contacts: ContactNow[]
) {
  const read = readingOf(people, inferred, corrections, contacts);
  // His word that a handle is not someone: a card holding that handle is not them by its name either.
  const isRuledOut = (c: ContactNow, ref: string) =>
    corrections.some(
      (x) =>
        x.kind === "not-this-person" &&
        x.person === ref &&
        c.handles.some((s) => isSameNameOrHandle(s, x.nameOrHandle))
    );
  const into = new Map<string, string>();
  for (const r of inferred) {
    const self = `person:${r.id}`;
    const to = r.namesAndHandles.map(read).find((x) => x && x !== self);
    if (to) {
      into.set(self, to);
    }
  }
  // A card whose whole name and whose handles say more than one person, to settle once the folds are known.
  const torn: { card: string; people: string[] }[] = [];
  for (const c of contacts) {
    const self = `person:${c.id}`;
    const says = saidBy(c, self, read, people, isRuledOut);
    if (says.people.length > 1) {
      torn.push({ card: self, people: says.people });
    } else if (says.people[0] ?? says.maybe) {
      into.set(self, (says.people[0] ?? says.maybe) as string);
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
  // A card he settled himself (`same-person`) is placed; one whose name and handles are one person after all (a
  // guess folded into them) is theirs; the rest is not Life's to place: no one's until he says (an ambiguous card), and each
  // handle truth/ knows still reads as its own person.
  const ambiguousCards = torn.flatMap((t) => {
    if (canon(t.card) !== t.card) {
      return [];
    }
    const now = [...new Set(t.people.map(canon))];
    if (now.length === 1) {
      into.set(t.card, now[0] as string);
      return [];
    }
    return [{ card: t.card, people: now }];
  });
  const resolve = (nameOrHandle: string): string | null => {
    const ref = read(nameOrHandle);
    return ref ? canon(ref) : null;
  };
  return { ambiguousCards, canon, resolve };
}

/**
 * Who a contact card says it is: `people`, whoever its whole name is in truth/ and whoever each of its handles reads
 * as (every handle, so their order never decides), each once; and `maybe`, whoever its name may still be when
 * nothing else says (`namesTheSame`).
 */
function saidBy(
  c: ContactNow,
  self: string,
  read: (nameOrHandle: string) => string | null,
  people: Person[],
  isRuledOut: (c: ContactNow, ref: string) => boolean
) {
  const named = read(c.name);
  const byName =
    named && named !== self && !isRuledOut(c, named) ? named : undefined;
  const whole = byName && isWholeNameOf(c, byName, people) ? byName : undefined;
  const handled = c.handles.flatMap((nameOrHandle) => {
    const ref = read(nameOrHandle);
    return ref && ref !== self ? [ref] : [];
  });
  return {
    maybe: byName && namesTheSame(byName, people) ? byName : undefined,
    people: [...new Set([...(whole ? [whole] : []), ...handled])],
  };
}

/**
 * Whether a card that is not named, whole, as `ref` and shares no handle with them is still that person, going by one
 * of their names: only when truth/ gives them no phone or email to say otherwise. A card named as an alias ("Paul")
 * of someone whose numbers are known and differ is someone else.
 */
function namesTheSame(ref: string, people: Person[]) {
  const person = people.find((p) => `person:${p.id}` === ref);
  return !person || handlesOf(person).every((h) => !contactKeyOf(h));
}

/** Whether a card is named, whole, as someone in truth/: his own label for the card. */
const isWholeNameOf = (c: ContactNow, ref: string, people: Person[]) =>
  people.some(
    (p) =>
      `person:${p.id}` === ref &&
      nameKey(c.name) !== "" &&
      nameKey(p.name) === nameKey(c.name)
  );

/**
 * What each observation is about today: the subjects it was filed with, plus the names Life could not map when it was
 * read and can now, folded (`foldsOf`); `unmapped` when it still names someone Life cannot map.
 * The pages and the search index both go by this.
 */
export function aboutNow(
  observations: Observation[],
  unresolved: Unresolved[],
  people: Person[],
  inferred: InferredPerson[],
  corrections: Correction[],
  contacts: ContactNow[],
  chatOf: Map<string, string> = new Map()
) {
  const { canon, resolve } = foldsOf(people, inferred, corrections, contacts);
  const found = unresolved.flatMap((u) =>
    u.observation
      ? [{ observation: u.observation, ref: resolve(u.nameAsWritten) }]
      : []
  );
  const named = Map.groupBy(found, (n) => n.observation);
  const namesOf = new Map<string, string[]>([
    ...peopleOutsideDirectoryOf(contacts, inferred).map(
      (p): [string, string[]] => [`person:${p.id}`, [p.name]]
    ),
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
    // A voice keeps lifelog's id, which the directory may not know: then, for an unknown one, the name lifelog gave it.
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
    const subjects = [
      ...new Set([
        ...o.subjects.map(canon).map((e) => moved.get(e) ?? e),
        ...(named.get(o.id) ?? []).flatMap((n) => (n.ref ? [n.ref] : [])),
        ...(resolvedNow ? [a.now] : []),
      ]),
    ].sort();
    return {
      ...o,
      // Who it is about changed since it was written (a move, a fold, a name resolved since): a page it lands on
      // has not read it (`pages.ts` offers it once).
      refiled: subjects.join() !== o.subjects.toSorted().join(),
      speaker: a.now,
      // A chat title named an unknown author; once they resolve, their name is the directory's.
      speakerName: resolvedNow ? undefined : o.speakerName,
      subjects,
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
 * The people and projects `texts` name: each run of one to three words that `resolve` knows (a name, alias or handle)
 * or that is a project's name. What a call involves beyond its people (`involvedOf`); a word that is also a name only
 * adds a directory entry to the call's input.
 */
export function namedIn(
  texts: string[],
  resolve: (nameOrHandle: string) => string | null,
  projects: { name: string; ref: string }[]
) {
  const projectNamed = new Map(projects.map((p) => [nameKey(p.name), p.ref]));
  const found = new Set<string>();
  for (const words of texts.map((t) => t.match(WORD) ?? [])) {
    for (const [i] of words.entries()) {
      for (let n = 1; n <= 3 && i + n <= words.length; n += 1) {
        const s = words.slice(i, i + n).join(" ");
        const ref =
          resolve(s) ?? (nameKey(s) ? projectNamed.get(nameKey(s)) : undefined);
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

/** An episode as the models see its people today: each mapped by `refOf` (an episode keeps the refs it was read with). */
export const episodeNow = <E extends { people: { ref: string }[] }>(
  m: E,
  refOf: (ref: string) => string
): E => ({ ...m, people: m.people.map((p) => ({ ...p, ref: refOf(p.ref) })) });

/** An observation as readers get it (`aboutNow`). */
export type Shown = ReturnType<typeof aboutNow>[number];

/**
 * truth/, the people his Contacts name, Life's inferred people and the owner's corrections, read once, with the
 * resolver and the folds over them.
 */
export async function readPeople() {
  const [truth, inferred, corrections] = await Promise.all([
    loadTruth(),
    readInferred(),
    readCorrections(),
  ]);
  const contacts = contactsNow(readContactLines());
  const { ambiguousCards, canon, resolve } = foldsOf(
    truth.people,
    inferred,
    corrections,
    contacts
  );
  const outsideDirectory = peopleOutsideDirectoryOf(contacts, inferred);
  const isGuessNow = guessTestOf(corrections);
  /** Who an episode's person ref is as of today. */
  const refOf = (ref: string) =>
    ref.startsWith(UNKNOWN)
      ? (resolve(ref.slice(UNKNOWN.length)) ?? ref)
      : canon(ref);
  const names = new Map<string, string>([
    ...[...truth.people, ...outsideDirectory].map(
      (p) => [`person:${p.id}`, p.name] as const
    ),
    ...truth.projects.map((p) => [`project:${p.id}`, p.name] as const),
    ...truth.areas.map((a) => [`area:${a.id}`, a.name] as const),
  ]);
  return {
    /** The Contacts cards Life cannot place: their whole name and their handles say more than one person (`foldsOf`). */
    ambiguousCards,
    canon,
    /** The people his Contacts name (`contact-people.ts`), for the folds. */
    contacts,
    corrections,
    inferred,
    /** Whether a person ref, as it reads today, is only a guess (`guessTestOf`). */
    isGuess: (ref: string) => isGuessNow(refOf(ref)),
    /** An episode's person ref as a reader sees it: the readable name of who it is today, else the bare id. */
    nameOf: (ref: string) =>
      names.get(refOf(ref)) ?? who({ speaker: refOf(ref) }),
    /** A readable name for each person (inferred ones too), project and area ref. */
    names,
    /** Everyone outside the directory (`peopleOutsideDirectoryOf`), folded or not: what every listing of people reads. */
    outsideDirectory,
    /** Who an episode's person ref is as of today: a name since resolved, a person since folded into another. */
    refOf,
    resolve,
    truth,
  };
}
export type People = Awaited<ReturnType<typeof readPeople>>;

/**
 * The observations the pages and the index go by, those that show (`observationStatusOf`: neither hidden everywhere nor replaced),
 * filed as they read today; with the ledgers that say where each stands, and every observation in the ledger.
 */
export async function observationsNow({
  contacts,
  corrections,
  inferred,
  truth,
}: People) {
  const read = readObservations();
  const [all, statusInputs, unresolved] = await Promise.all([
    read,
    readObservationStatusInputs(corrections, read),
    readUnresolved(),
  ]);
  const shown = shownOf(all, statusInputs);
  const needingHandles = shown.filter(
    (o) =>
      !o.speakerFrom && o.speaker !== OWNER && !o.speaker.startsWith(UNKNOWN)
  );
  const units = readUnitsFor(
    needingHandles.map((o) => o.unit),
    needingHandles.map((o) => o.date)
  );
  const observations = aboutNow(
    shown,
    unresolved,
    truth.people,
    inferred,
    corrections,
    contacts,
    chatHandles(units)
  );
  return { all, observations, statusInputs };
}

/** Who goes by this name (or id): the people in the directory and the ones Life inferred, by name or alias. */
export function namedLike<
  T extends { aliases: string[]; id: string; name: string },
>(name: string, people: T[]) {
  return people.filter(
    (p) =>
      p.id === name ||
      (nameKey(name) !== "" &&
        [p.name, ...p.aliases].some((n) => nameKey(n) === nameKey(name)))
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
  const q = nameKey(name);
  const max = q.length <= 4 ? 1 : 2;
  const best = new Map<string, { d: number; p: T }>();
  for (const p of people) {
    for (const n of [p.name, ...p.aliases].map(nameKey)) {
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

/**
 * Everyone a name can mean: the people in his directory, and those his Contacts name or Life inferred (not folded into
 * another), going by their names and handles too.
 */
function nameable({
  outsideDirectory,
  canon,
  truth,
}: Pick<People, "outsideDirectory" | "canon" | "truth">) {
  return [
    ...truth.people,
    ...new Map(
      unfoldedOf(outsideDirectory, canon).map((p) => [
        p.id,
        { ...p, aliases: p.namesAndHandles },
      ])
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
  people: Pick<People, "outsideDirectory" | "canon" | "resolve" | "truth">
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

/**
 * Who a mention means, with the proof: `name`, the person its whole `who` resolves to (`people.resolve`, so a fold or a
 * name given since moves it); else, when its `who` is a relation's word ("my father") and exactly one of its speaker's
 * `ties` is that relation, that tie's person: `relation_word` for his directory's word, `tie` when someone said it in
 * words (`quote`, `writeTies`). A word that does not name one person by its nature (`namesOne`; "my brother",
 * "my friend") is placed only by a tie said in words (two fathers, or none, mean no one). Either way its words must be on its
 * line; else no one. "Paul's sister" is not "Paul": a part of a name never counts.
 */
export function placementOf(
  mention: { by: string; line: string; who: string },
  people: Pick<People, "resolve">,
  ties: TieNow[]
) {
  const words = ` ${nameKey(mention.who)} `;
  if (!(words.trim() && ` ${nameKey(mention.line)} `.includes(words))) {
    return null;
  }
  const ref = people.resolve(mention.who);
  if (ref) {
    return { proof: "name" as const, ref };
  }
  const word = relationWordOf(mention.who);
  const speaker = mention.by === OWNER ? OWNER : people.resolve(mention.by);
  const own = ties.filter((t) => t.by === speaker && t.word === word);
  const [only] = own;
  if (!(word && own.length === 1 && only && (only.quote || namesOne(word)))) {
    return null;
  }
  return only.quote
    ? { proof: "tie" as const, ref: only.of }
    : { proof: "relation_word" as const, ref: only.of };
}
