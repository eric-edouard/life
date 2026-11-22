import { digest } from "../core/hash";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { settings } from "../core/settings";
import { isSameBirthday } from "../records/fields";
import {
  CONTACT_PREFIX,
  type Correction,
  INFERRED_PREFIX,
  type InferredPerson,
  type Observation,
  peopleOutsideDirectoryOf,
  type Unresolved,
  unfoldedOf,
} from "../records/observation";
import { namesOne, relationWordOf } from "../records/relation-words";
import { type DirectoryParty, firstNameOf, ME } from "../records/truth";
import type { Unit } from "../records/unit";
import { contactKeyOf } from "../sources/contacts";
import { voiceKey } from "../sources/lifelog-voices";
import { readLidPhones } from "../sources/whatsapp";
import { readAgentReports } from "./agent-source";
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
import { isSameNameOrHandle, type Reading, readingOf } from "./name-reading";
import {
  type PictureIndex,
  partyOf,
  pictureChoicesOf,
  readPictureIndex,
} from "./party";
import {
  directoryPartiesOf,
  loadTruth,
  OWNER,
  phonesAndEmailsOf,
} from "./read-truth";
import {
  guessTestOf,
  knownTestOf,
  latestInUseOf,
  organizationTestOf,
} from "./ref-kinds";
import { kindOf, sourceOf } from "./sources";
import type { Tie } from "./ties";
import { dayUnitId } from "./unit-ids";
import { type HandleFrom, holdsName, nameKey, PERSON, UNKNOWN } from "./units";

// Who a name, handle or person ref is now: truth/, the people his Contacts name, the people Life inferred and the
// owner's corrections, in that order of trust under his word. Every reader and step resolves people through here.

const WHO = /^(person|unknown):/;
/** A speaker as a reader sees it: the readable name when there is one (else `nameOf`'s, so an id never reaches a model as a word), else the id without its `person:` prefix. */
export const who = (
  x: { speaker: string; speakerName?: string },
  nameOf?: (ref: string) => string
) => x.speakerName ?? nameOf?.(x.speaker) ?? x.speaker.replace(WHO, "");

const tierOf = (ref: string) => {
  if (ref.startsWith(`person:${INFERRED_PREFIX}`)) {
    return 2;
  }
  return ref.startsWith(`person:${CONTACT_PREFIX}`) ? 1 : 0;
};

/** The ref a loop of folds reads as: the best tier (truth/, then his Contacts, then a guess), then the smallest. */
const bestOf = (loop: string[]) =>
  loop.toSorted(
    (a, b) => tierOf(a) - tierOf(b) || a.localeCompare(b)
  )[0] as string;

/**
 * Who a name as written and a person ref are now: `resolve` is what a name as written reads as (`readingOf`), folded; `canon` folds a
 * ref, his `same-person` over what each inferred id's name as written reads as now, so every id a name as written was ever given is
 * the one person it reads as. A contact person folds too: into whoever its whole name is in truth/, else by a handle
 * it shares with someone, else by its name (`namesTheSame`); and a guess made for one of its handles is the contact
 * person. A card whose whole name and whose handles say more than one person folds into no one (an ambiguous card: his to say).
 * A WhatsApp `@lid` reads as the phone its bridge maps it to (`lidPhones`), so a guess made for it is that phone's person.
 */
export function foldsOf(
  people: DirectoryParty[],
  inferred: InferredPerson[],
  corrections: Correction[],
  contacts: ContactNow[],
  lidPhones?: ReadonlyMap<string, string>
) {
  const reading = readingOf(people, inferred, corrections, contacts, lidPhones);
  const read = (nameOrHandle: string, from?: HandleFrom) =>
    reading(nameOrHandle, from)?.ref ?? null;
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
    const to = r.namesAndHandles
      .map((x) => read(x))
      .find((x) => x && x !== self);
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
    const path: string[] = [];
    let r = ref;
    while (into.has(r) && !path.includes(r)) {
      path.push(r);
      r = into.get(r) as string;
    }
    // A loop reads as its best ref: truth/, then his Contacts, then a guess, then the smallest id.
    return into.has(r) ? bestOf(path.slice(path.indexOf(r))) : r;
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
  /** What a name as written reads as now, folded, with where that came from; `from` where it was read, when known. */
  const readingNow = (
    nameOrHandle: string,
    from?: HandleFrom
  ): Reading | null => {
    const r = reading(nameOrHandle, from);
    return r && { ...r, ref: canon(r.ref) };
  };
  const resolve = (nameOrHandle: string, from?: HandleFrom) =>
    readingNow(nameOrHandle, from)?.ref ?? null;
  return { ambiguousCards, canon, readingNow, resolve };
}

/**
 * Who a contact card says it is: `people`, whoever its whole name is in truth/ and whoever each of its handles reads
 * as (every handle, so their order never decides), and whoever has the card's first name and birthday
 * (`isSameFirstNameAndBirthday`), each once; and `maybe`, whoever its name may still be when
 * nothing else says (`namesTheSame`).
 */
function saidBy(
  c: ContactNow,
  self: string,
  read: (nameOrHandle: string, from?: HandleFrom) => string | null,
  people: DirectoryParty[],
  isRuledOut: (c: ContactNow, ref: string) => boolean
) {
  const named = read(c.name);
  const byName =
    named && named !== self && !isRuledOut(c, named) ? named : undefined;
  const whole = byName && isWholeNameOf(c, byName, people) ? byName : undefined;
  const handled = c.handles.flatMap((nameOrHandle) => {
    const ref = read(nameOrHandle, "contacts");
    return ref && ref !== self ? [ref] : [];
  });
  const born = people.flatMap((p) => {
    const ref = `person:${p.id}`;
    return ref !== self &&
      !isRuledOut(c, ref) &&
      isSameFirstNameAndBirthday(c, p)
      ? [ref]
      : [];
  });
  return {
    maybe: byName && namesTheSame(byName, people) ? byName : undefined,
    people: [...new Set([...(whole ? [whole] : []), ...handled, ...born])],
  };
}

/**
 * Whether a card that is not named, whole, as `ref` and shares no handle with them is still that person, going by one
 * of their names: only when truth/ gives them no phone or email to say otherwise. A card named as an alias ("Paul")
 * of someone whose numbers are known and differ is someone else.
 */
function namesTheSame(ref: string, people: DirectoryParty[]) {
  const person = people.find((p) => `person:${p.id}` === ref);
  return !person || phonesAndEmailsOf(person).every((h) => !contactKeyOf(h));
}

/** Whether a card has the first name and the birthday of someone in truth/: proof enough, never one alone. The first word is taken before `nameKey`, which would split "Jean-Pierre". */
const isSameFirstNameAndBirthday = (c: ContactNow, p: DirectoryParty) => {
  const first = (name: string) => nameKey(firstNameOf(name));
  return (
    !!c.birthday &&
    !!p.birthday &&
    first(c.name) !== "" &&
    first(c.name) === first(p.name) &&
    isSameBirthday(c.birthday, p.birthday)
  );
};

/** Whether a card is named, whole, as someone in truth/: his own label for the card. */
const isWholeNameOf = (c: ContactNow, ref: string, people: DirectoryParty[]) =>
  people.some(
    (p) =>
      `person:${p.id}` === ref &&
      nameKey(c.name) !== "" &&
      nameKey(p.name) === nameKey(c.name)
  );

/**
 * What each observation is about today: the subjects it was filed with, plus the names Life could not map when it was
 * read and can now, folded (`canon` and `resolve`, `readPeople`'s); `unmapped` when it still names someone Life cannot map.
 * The pages and the search index both go by this.
 */
export function aboutNow(
  observations: Observation[],
  unresolved: Unresolved[],
  people: DirectoryParty[],
  inferred: InferredPerson[],
  contacts: ContactNow[],
  { canon, resolve }: Pick<People, "canon" | "resolve">,
  chatOf: Map<string, string> = new Map()
) {
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
      voicePersonOf(
        (x) => resolve(x, o.source.channel),
        from,
        unknown ? was.slice(UNKNOWN.length) : null
      ) || was;
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
 * Who a lifelog person id is: the id, else the name lifelog gave it (`readVoiceNames`: the directory knows the id of few
 * people), which the caller passes as `name`. The one rule.
 */
export const voicePersonOf = (
  resolve: (s: string) => string | null,
  id: string | null | undefined,
  name: string | null | undefined
) => (id ? resolve(id) : null) ?? (name ? resolve(name) : null);

/** A queue item as a voice card reads it: lifelog's, with the voice naming's guesses (`guessed`) and the names lifelog gives its person ids (`names`), both from `withVoiceGuesses`. */
interface VoiceCardItem {
  guessed?: readonly string[];
  likely: readonly string[];
  name: string | null;
  names?: Readonly<Record<string, string>>;
  personId: string | null;
}

/**
 * The person a voice card asks about, what its "Yes" names (its `subject`): the one person the voice naming guessed for
 * its voices (`guessed`, `withVoiceGuesses`; only someone known today), which offers only who could be there
 * (`possibleSpeakersOf`), and lifelog's suggestion (its person, else the name it heard, as `resolve` reads it) does not
 * contradict; none otherwise. "Yes" assigns lifelog's id for them (`voiceIdOf`), else names a new person of Voice by
 * their name (his yes of 22 Nov 2026: a guess may be someone Voice has not heard yet). Lifelog's suggestion alone never names anyone: it reads sound and words, not who could be there. Only ever
 * a question to him ("Is this X?"): his tap is the answer.
 */
export function voiceSuggestionOf(
  people: Pick<People, "names" | "refOf" | "resolve">,
  item: VoiceCardItem
) {
  const guessed = new Set(
    (item.guessed ?? [])
      .map((g) => people.refOf(g))
      .filter((r) => people.names.has(r))
  );
  const lifelog = voicePersonOf(
    people.resolve,
    item.personId,
    item.names?.[item.personId ?? ""] ?? item.name
  );
  const [one] = guessed;
  return guessed.size === 1 && (lifelog === null || lifelog === one)
    ? (one as string)
    : null;
}

/**
 * The lifelog person id a voice answer naming `ref` assigns ("Yes", "Someone else…"), each id read as `voicePersonOf`
 * with the name lifelog gives it: the card's own (its person, its `likely`, named in `names`) first, else the one id of
 * `elsewhere` (id → lifelog's name), never one of two; none when lifelog knows them by no such id.
 */
export function voiceIdOf(
  people: Pick<People, "resolve">,
  item: Pick<VoiceCardItem, "likely" | "names" | "personId">,
  ref: string,
  elsewhere: Readonly<Record<string, string>> = {}
) {
  const isRef = (id: string, name?: string) =>
    voicePersonOf(people.resolve, id, name) === ref;
  const own = [item.personId, ...item.likely].find(
    (id): id is string => !!id && isRef(id, item.names?.[id])
  );
  const other = Object.entries(elsewhere).filter(([id, name]) =>
    isRef(id, name)
  );
  return own ?? (other.length === 1 ? other[0]?.[0] : undefined);
}

/**
 * A voice card's ref: its lifelog group, the recordings his answer would change (a digest of its voices) and the person
 * it suggests, so an answer reaches only the card he saw (`voiceSuggestionOf`): a group that grew or changed its
 * suggestion is another card.
 */
export const voiceCardRefOf = (
  people: Pick<People, "names" | "refOf" | "resolve">,
  item: VoiceCardItem & {
    id: string;
    voices: { jobId: string; speakerLabel: string }[];
  }
) => {
  const voices = [
    ...new Set(item.voices.map((v) => voiceKey(v.jobId, v.speakerLabel))),
  ].sort();
  const suggested = voiceSuggestionOf(people, item);
  return `voice:${item.id}~${digest("sha256", voices.join("\n"), 8)}${suggested ? `~${suggested}` : ""}`;
};

/** What a card asks about, its ref less what binds it to the question shown: a voice card's group (`voiceCardRefOf`), else the ref. A push notifies once per subject (`pushNewCards`). */
export const cardSubjectOf = (ref: string) =>
  ref.startsWith("voice:") ? (ref.split("~")[0] ?? ref) : ref;

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
  refOf: (ref: string, from?: HandleFrom) => string
): U => ({
  ...u,
  people: u.people
    .map((p) => refOf(p, u.source))
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
 * Whose a Contacts card is, the one rule (details, pictures): its contact person as the folds place it when Life keeps
 * one (an ambiguous card stays its own until he says), else the one person all of its handles that name someone name;
 * no one when they name several.
 */
export const cardOwnerOf =
  ({
    canon,
    contacts,
    resolve,
  }: {
    canon: (ref: string) => string;
    contacts: { card: string; id: string }[];
    resolve: (nameOrHandle: string, from?: HandleFrom) => string | null;
  }) =>
  (card: { handles: string[]; id: string }) => {
    const kept = contacts.find((c) => c.card === card.id);
    if (kept) {
      return canon(`person:${kept.id}`);
    }
    const named = new Set(
      card.handles.flatMap((h) => resolve(h, "contacts") ?? [])
    );
    return named.size === 1 ? [...named][0] : undefined;
  };

/** The bridge's map of WhatsApp lids to phones while WhatsApp is a source he turned on; a store it cannot read is logged, and no lid reads as a phone. */
function lidPhonesNow() {
  if (!settings().sources.includes("whatsapp")) {
    return new Map<string, string>();
  }
  try {
    return readLidPhones();
  } catch (e) {
    log("run.error", { ...errorOf(e), step: "people.lid-phones" });
    return new Map<string, string>();
  }
}

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
  const lidPhones = lidPhonesNow();
  const parties = directoryPartiesOf(truth);
  // The pictures, read once for every party and picture choice this read gives.
  let pictureIndex: PictureIndex | undefined;
  const readPicturesOnce = () => {
    pictureIndex ??= readPictureIndex();
    return pictureIndex;
  };
  const choicesOf = pictureChoicesOf(parties, readPicturesOnce);
  const { ambiguousCards, canon, readingNow, resolve } = foldsOf(
    parties,
    inferred,
    corrections,
    contacts,
    lidPhones
  );
  const outsideDirectory = peopleOutsideDirectoryOf(contacts, inferred);
  const latest = latestInUseOf(inferred);
  const isGuessNow = guessTestOf(corrections, latest);
  const isKnownNow = knownTestOf(corrections);
  const isOrganizationNow = organizationTestOf(truth.organizations, latest, {
    canon,
    corrections,
  });
  /** Who a ref is as of today: an unresolved one (`unknown:<as written>`) read again, from where it was read when known. */
  const refOf = (ref: string, from?: HandleFrom) =>
    ref.startsWith(UNKNOWN)
      ? (resolve(ref.slice(UNKNOWN.length), from) ?? ref)
      : canon(ref);
  const names = new Map<string, string>([
    ...[...parties, ...outsideDirectory].map(
      (p) => [`person:${p.id}`, p.name] as const
    ),
    ...truth.projects.map((p) => [`project:${p.id}`, p.name] as const),
    ...truth.areas.map((a) => [`area:${a.id}`, a.name] as const),
  ]);
  /** What each person is to him, one line: truth/'s `relation`, a contact's card, an inferred person's relation. */
  const relations = new Map<string, string>([
    ...outsideDirectory.map((p) => [`person:${p.id}`, p.relation] as const),
    ...parties.flatMap((p) =>
      p.relation ? [[`person:${p.id}`, p.relation] as const] : []
    ),
  ]);
  /** Last: their role now at an organization of his directory ("Founder, Atelier Morel"), the first that names them. */
  const roles = new Map<string, string>();
  for (const o of truth.organizations) {
    for (const p of o.people) {
      if (p.until === undefined && !roles.has(`person:${p.id}`)) {
        roles.set(`person:${p.id}`, `${p.role}, ${o.name}`);
      }
    }
  }
  const relationOf = (ref: string) =>
    relations.get(refOf(ref)) ?? roles.get(refOf(ref)) ?? null;
  const isOrganization = (ref: string) => isOrganizationNow(refOf(ref));
  const nameOf = (ref: string) =>
    names.get(refOf(ref)) ?? who({ speaker: refOf(ref) });
  return {
    /** The Contacts cards Life cannot place: their whole name and their handles say more than one person (`foldsOf`). */
    ambiguousCards,
    /** Who a name could be, as he knows them (`nearNames` over `nameable`): their refs as they read today. */
    candidatesFor: (name: string): string[] =>
      nearNames(
        name,
        nameable({ canon, outsideDirectory, truth }).filter((p) => p.id !== ME)
      ).map((p) => refOf(`person:${p.id}`)),
    canon,
    /** The people his Contacts name (`contact-people.ts`), for the folds. */
    contacts,
    corrections,
    inferred,
    /** Whether a person ref, as it reads today, is only a guess (`guessTestOf`). */
    isGuess: (ref: string) => isGuessNow(refOf(ref)),
    /** Whether a person ref, as it reads today, is someone he knows (`knownTestOf`). */
    isKnownToHim: (ref: string) => isKnownNow(refOf(ref)),
    /** Whether a person ref, as it reads today, is an organization (`organizationTestOf`): personal steps skip it. */
    isOrganization,
    /** An episode's person ref as a reader sees it: the readable name of who it is today, else the bare id. */
    nameOf,
    /** A readable name for each person (inferred ones too), project and area ref. */
    names,
    /** Everyone outside the directory (`peopleOutsideDirectoryOf`), folded or not: what every listing of people reads. */
    outsideDirectory,
    /** Whose a Contacts card is (`cardOwnerOf`). */
    ownerOfCard: cardOwnerOf({ canon, contacts, resolve }),
    /** A ref as every app is shown it (`partyOf`), over the pictures read once. */
    partyOf: partyOf(
      { isOrganization, nameOf, refOf, relationOf },
      parties,
      readPicturesOnce
    ),
    /** The pictures he can pick from for a ref as it reads today (`pictureChoicesOf`), from the index `partyOf` reads. */
    pictureChoicesOf: (ref: string) => choicesOf(refOf(ref)),
    /** What a name as written reads as now (`resolve`), with which source said so and whether the name is shared. */
    readingNow,
    /** Who an episode's person ref is as of today: a name since resolved, a person since folded into another. */
    refOf,
    /** What a person is to him, in one line (his directory's relation, his Contacts, or Life's guess); null when nothing says. */
    relationOf,
    resolve,
    truth,
  };
}
export type People = Awaited<ReturnType<typeof readPeople>>;

/**
 * The unresolved names that are people: `unresolved.jsonl` less the name that opens an agent's own report, which is that
 * agent (the unit's own agent, in an agent unit; the same name anywhere else stays). Reads disk; rewrites nothing, and
 * is not a test of whether a name is an agent's anywhere.
 */
export async function readUnresolvedPeople() {
  const agentOf = new Map(
    readAgentReports(new Date(0)).map((r) => [dayUnitId(r.event), r.agent])
  );
  return (await readUnresolved()).filter((u) => {
    const agent = agentOf.get(u.unit);
    return !agent || nameKey(agent) !== nameKey(u.nameAsWritten);
  });
}

/**
 * The observations the pages and the index go by, those that show (`observationStatusOf`: neither hidden everywhere nor replaced),
 * filed as they read today; with the ledgers that say where each stands, and every observation in the ledger.
 */
export async function observationsNow(people: People) {
  const { contacts, corrections, inferred, truth } = people;
  const read = readObservations();
  const [all, statusInputs, unresolved] = await Promise.all([
    read,
    readObservationStatusInputs(corrections, read),
    readUnresolvedPeople(),
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
    directoryPartiesOf(truth),
    inferred,
    contacts,
    people,
    chatHandles(units)
  );
  return { all, observations, statusInputs };
}

/**
 * The refusal for a name no one goes by, in one line, with who it could be (`candidatesFor`) by whole name and id:
 * either resolves, a part of a name never does.
 */
export const nameRefusalOf = (
  name: string,
  people: Pick<People, "candidatesFor" | "nameOf">
) => {
  const near = people
    .candidatesFor(name)
    .map((ref) => `${people.nameOf(ref)} (${ref.replace(PERSON, "")})`);
  return `No one goes by ${name}${near.length > 0 ? `; near it: ${near.join(", ")}` : ""}`;
};

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
    ...directoryPartiesOf(truth),
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

/** `meant`'s answer, but a part read by id (`byId`) takes the person with exactly that id before any name or alias. */
export function personFor(
  name: string,
  meaning: ReturnType<typeof meant>,
  byId?: boolean
) {
  const exact = byId ? meaning.all.find((p) => p.id === name) : undefined;
  return exact ? { ...meaning, known: exact.id, same: [] } : meaning;
}

/**
 * Who a mention means, with the proof: `name`, the person its whole `who` resolves to (`people.resolve`, so a fold or a
 * name given since moves it); else `relation_word`, when its `who` is a relation's word ("my father") and exactly one
 * of its speaker's `ties` is that relation and the word names one person by its nature (`one`, `records/relation-words.ts`; "my brother" or "my friend" never) (two fathers, or none, mean no one). Either way its words must be on its
 * line; else no one. "Paul's sister" is not "Paul": a part of a name never counts.
 */
export function placementOf(
  mention: { by: string; line: string; who: string },
  people: Pick<People, "resolve">,
  ties: Tie[]
) {
  if (!holdsName(mention.line, [mention.who])) {
    return null;
  }
  const ref = people.resolve(mention.who);
  if (ref) {
    return { proof: "name" as const, ref };
  }
  const word = relationWordOf(mention.who);
  const speaker = mention.by === OWNER ? OWNER : people.resolve(mention.by);
  if (!(word && namesOne(word))) {
    return null;
  }
  const of = new Set(
    ties.filter((t) => t.by === speaker && t.word === word).map((t) => t.of)
  );
  const [only] = of;
  return of.size === 1 && only
    ? { proof: "relation_word" as const, ref: only }
    : null;
}
