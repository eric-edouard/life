import {
  type Correction,
  INFERRED_USE_AT,
  type InferredPerson,
} from "../records/observation";
import type { Person } from "../records/truth";
import { contactKeyOf, writtenContactKeyOf } from "../sources/contacts";
import type { ContactNow } from "./contact-people";
import { handlesOf, phonesAndEmailsOf } from "./read-truth";
import { sourceOf } from "./sources";
import { type HandleFrom, nameKey } from "./units";

// What a name, handle or address reads as, before folds (`readingOf`): his word, truth/, his Contacts, then Life's
// guesses. Exact handles and contact keys (a phone, an email) live in maps of their own, and a string has a contact
// key only when its kind says so (where it was read, `HandleFrom`): a network's id never meets a phone's digits.
// `who.ts` folds what it reads.

/** A bridged user as Beeper writes it (`@line__u9:beeper.local`): the network's prefix and Beeper's server around the localpart Life's own bridge keeps (`_u9`). */
const BEEPER_GHOST = /^@[a-z0-9]+?_(.+):beeper\.local$/;

/** A name or handle's lookup keys: as given, lowercased, normalized; a Beeper ghost id also as its localpart, so both bridges' ids for one user read as one. */
export const keysOf = (s: string) =>
  [
    s.trim(),
    s.trim().toLowerCase(),
    nameKey(s),
    s.trim().match(BEEPER_GHOST)?.[1],
  ].filter((k): k is string => !!k);

/**
 * A name or handle's contact key, by where it was read (`from`): a Contacts field's always, a source's number when its
 * senders are phones (`hasPhoneHandles`), else only an address or a `+` number (`writtenContactKeyOf`). Contact keys
 * live in maps of their own, apart from the exact keys (`keysOf`): a network's id never meets a phone's digits.
 */
const contactKeyFrom = (nameOrHandle: string, from?: HandleFrom) =>
  from === "contacts"
    ? contactKeyOf(nameOrHandle)
    : writtenContactKeyOf(
        nameOrHandle,
        !!from && !!sourceOf(from).hasPhoneHandles
      );

/** Whether a card's handle and a name or handle as written are one: a key in common, or the same phone or email. */
export const isSameNameOrHandle = (
  cardHandle: string,
  nameOrHandle: string
) => {
  const key = contactKeyOf(cardHandle);
  return (
    (key !== undefined && key === writtenContactKeyOf(nameOrHandle)) ||
    keysOf(cardHandle).some((k) => keysOf(nameOrHandle).includes(k))
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
 * Every handle in the directory to the person who owns it: `exact`, each as written; `contact`, each phone and email by
 * its contact key (`contactKeyOf`), so one written another way ("06 11 11 11 11", "+33611111111") still meets. A
 * Telegram id, a GitHub login or a lifelog id is only ever exact.
 */
const handleIndex = (people: Person[]) => ({
  contact: new Map(
    people.flatMap((p) =>
      phonesAndEmailsOf(p).flatMap((h) => {
        const key = contactKeyOf(h);
        return key ? [[key, p.id] as const] : [];
      })
    )
  ),
  exact: new Map(
    people.flatMap((p) => handlesOf(p).map((h) => [h, p.id] as const))
  ),
});

/**
 * Who a name, handle or address reads as, before folds, in this order: what the owner said it is (`this-is`), `truth/`
 * (handles, then names and aliases), the person his Contacts name (a handle of its card, else its name when one
 * contact person alone goes by it), then its latest confident inferred guess (the person in truth/ it links to, else
 * the guess). His Contacts are his word on a number: no guess outranks a card. A `not-this-person` correction blocks
 * that match. Each reading says which of those it came from (`by`) and whether more than one person in truth/ or his
 * Contacts goes by that name (`isShared`), so an answer by a typed name can refuse a guess or a shared name.
 */
export function readingOf(
  people: Person[],
  inferred: InferredPerson[],
  corrections: Correction[],
  contacts: ContactNow[]
) {
  const handles = handleIndex(people);
  const names = nameIndex(people);
  // A card's handles (Contacts' phone and email fields): by their contact key; exact as written only one too short
  // to have one.
  const carded = {
    contact: new Map<string, string>(),
    exact: new Map<string, string>(),
  };
  const card = (into: Map<string, string>, key: string, id: string) => {
    if (!into.has(key)) {
      into.set(key, id);
    }
  };
  for (const c of contacts) {
    for (const s of c.handles) {
      const key = contactKeyOf(s);
      if (key) {
        card(carded.contact, key, c.id);
        continue;
      }
      for (const k of keysOf(s)) {
        card(carded.exact, k, c.id);
      }
    }
  }
  const cardNames = nameIndex(contacts.map((c) => ({ ...c, aliases: [] })));
  // His word, and what is looked up against it: a phone or an email by its contact key alone, anything else by its
  // exact keys alone (the contact key behind a prefix no exact key has): "+33 6…" never meets an id "336…".
  const wordKeysOf = (nameOrHandle: string, key: string | undefined) =>
    key ? [`\0${key}`] : keysOf(nameOrHandle);
  const said = new Map<string, string>();
  const not = new Set<string>();
  for (const c of corrections) {
    if (c.kind !== "this-is" && c.kind !== "not-this-person") {
      continue;
    }
    for (const k of wordKeysOf(
      c.nameOrHandle,
      writtenContactKeyOf(c.nameOrHandle)
    )) {
      if (c.kind === "this-is") {
        said.set(k, c.person);
      } else {
        not.add(`${k}|${c.person}`);
      }
    }
  }
  const guessed = guessesOf(inferred);
  const meet = (
    index: { contact: Map<string, string>; exact: Map<string, string> },
    key: string | undefined,
    ks: string[]
  ) =>
    key
      ? index.contact.get(key)
      : ks.map((k) => index.exact.get(k)).find(Boolean);
  // A phone or an email (it has a contact key) meets only phones and emails: truth/'s, a card's, his word's; anything
  // else only exact handles and names. Life's guesses are the one exception: a model wrote their handles, with no kind,
  // so each meets as written.
  return (nameOrHandle: string, from?: HandleFrom): Reading | null => {
    const key = contactKeyFrom(nameOrHandle, from);
    const ks = keysOf(nameOrHandle);
    const words = wordKeysOf(nameOrHandle, key);
    const truth = meet(handles, key, ks.slice(0, 2));
    // A name as lifelog gives it, its parentheses left out ("Jean (Me)").
    const bare = key ? "" : nameKey(nameOrHandle.trim().replace(PAREN, ""));
    const named = bare ? names.get(bare) : undefined;
    const guesses = ks.map((k) => guessed.get(k));
    const onCard =
      meet(carded, key, ks) ?? (bare ? cardNames.get(bare) : undefined);
    const isShared =
      !!bare && (names.get(bare) === null || cardNames.get(bare) === null);
    const tiers: (readonly [Reading["by"], string | null | undefined])[] = [
      ...words.map((k) => ["his word", said.get(k)] as const),
      ["truth", truth && `person:${truth}`],
      ["truth", named && `person:${named}`],
      ["contacts", onCard && `person:${onCard}`],
      ...guesses.map((g) => ["guess", g?.person] as const),
      ...guesses.map((g) => ["guess", g && `person:${g.id}`] as const),
    ];
    const found = tiers.find(
      ([, r]) => r && !words.some((k) => not.has(`${k}|${r}`))
    );
    return found?.[1] ? { by: found[0], isShared, ref: found[1] } : null;
  };
}

/** What a name, handle or address reads as (`readingOf`): the person, and which of Life's sources said so. */
export interface Reading {
  by: "his word" | "truth" | "contacts" | "guess";
  isShared: boolean;
  ref: string;
}
