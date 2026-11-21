import { latestInUseOf } from "./ref-kinds";
import { nameKey } from "./units";
import type { People } from "./who";

// The likely matches the folds leave (life#727): a guess Life uses and someone else going by its whole name, or someone
// he knows whom Life already knows by the guess's name, never joined by a fact. Asked as one card ("Are these the same
// person?"), never decided by Life; worked out when the inbox is read, never stored.

const REF = /^same:(person:[^~]+)~(person:[^~]+)$/;
/** A card's ref, bound to both people, so a tap answers only the pair he saw. */
export const samePersonRefOf = (guess: string, other: string) =>
  `same:${guess}~${other}`;
/** The guess and the other person a card's ref names; none for another ref. */
export const samePersonPairOf = (ref: string) => {
  const [, guess = "", other = ""] = ref.match(REF) ?? [];
  return { guess, other };
};

/** A chat's handle (a network's id, a bridge's sender, a phone, an address), not a name: what his "Different people" is written against. */
const HANDLE = /^[@+_\d]|@/;
const SPACES = /\s+/;
/** A whole name: two words or more, as written ("Jean-Pierre" is one). */
const isWholeName = (n: string) => n.trim().split(SPACES).length > 1;
const LOWER = /^\p{Ll}/u;
/** A guess's description, not a name: it starts in lower case ("the shop plumber"); its name field holds one when the messages gave no name. */
const isDescription = (n: string) => LOWER.test(n.trim());
/**
 * Each guess in use (`isGuess`: not settled, not his word), not folded, not an organization, with a handle, and someone
 * else going by its whole name: his directory (a name or an alias), his Contacts, or another such guess (one card for
 * the two, asked of the one with handles, the smaller id when both have); or, by any name, someone not a guess whom its
 * name reads as by his word or by another of Life's readings linked to them (`readingNow`), the account's other name
 * (`called`). A pair his word settled is never asked
 * again: `same-person` folded it, or a `not-this-person` on a handle that reads as one of them names the other.
 */
export function samePersonPairsOf(
  people: Pick<
    People,
    | "canon"
    | "contacts"
    | "corrections"
    | "inferred"
    | "isGuess"
    | "isOrganization"
    | "readingNow"
    | "relationOf"
    | "resolve"
    | "truth"
  >
) {
  const { canon } = people;
  const guesses = new Map(
    [...latestInUseOf(people.inferred)].filter(
      ([ref]) =>
        canon(ref) === ref && people.isGuess(ref) && !people.isOrganization(ref)
    )
  );
  // Its handles that still read as it: one he refused for it reads as no one, and is never asked about again.
  const handlesOf = (ref: string) => {
    const g = guesses.get(ref);
    return (g?.namesAndHandles ?? []).filter(
      (h) =>
        HANDLE.test(h) &&
        nameKey(h) !== nameKey(g?.name ?? "") &&
        people.resolve(h) === ref
    );
  };
  /** What someone is to him, with a guess's handle, so two of one name read apart. */
  const lineOf = (ref: string) =>
    [people.relationOf(ref), handlesOf(ref)[0]].filter(Boolean).join(", ");
  const byName = Map.groupBy(
    [
      ...people.truth.people.flatMap((p) =>
        [p.name, ...p.aliases].map((n) => ({ n, ref: `person:${p.id}` }))
      ),
      ...people.contacts.map((c) => ({ n: c.name, ref: `person:${c.id}` })),
      ...[...guesses].flatMap(([ref, g]) =>
        isDescription(g.name) ? [] : [{ n: g.name, ref }]
      ),
    ].filter(({ n }) => isWholeName(n)),
    ({ n }) => nameKey(n)
  );
  // His "Different people", either way round: a handle refused for one that reads as the other now.
  const refused = new Set(
    people.corrections.flatMap((c) => {
      const reads =
        c.kind === "not-this-person" && people.resolve(c.nameOrHandle);
      const to = c.kind === "not-this-person" ? canon(c.person) : "";
      return reads ? [`${reads}|${to}`, `${to}|${reads}`] : [];
    })
  );
  const isAskedOf = (guess: string, other: string) =>
    handlesOf(guess).length > 0 &&
    !(handlesOf(other).length > 0 && other < guess);
  const pairs = new Map<
    string,
    {
      /** The guess's name Life knows the other by, when that is what joins them; null: the same whole name. */
      called: string | null;
      guess: string;
      handles: string[];
      lines: [string, string];
      other: string;
    }
  >();
  for (const [guess, g] of guesses) {
    // A name alone is weak: his directory or his Contacts going by a first name asks nothing, nor a name two of his
    // people share that a guess links to one of them; only his word or a reading linked to one person does.
    const reads = isDescription(g.name) ? null : people.readingNow(g.name);
    const isLinked =
      reads?.by === "his word" || (reads?.by === "guess" && !reads.isShared);
    const others = [
      ...(isWholeName(g.name) && !isDescription(g.name)
        ? (byName.get(nameKey(g.name)) ?? [])
        : []
      ).map(({ ref }) => ({ called: null, ref })),
      ...(reads && isLinked && !people.isGuess(reads.ref)
        ? [{ called: g.name, ref: reads.ref }]
        : []),
    ];
    for (const { called, ref } of others) {
      const other = canon(ref);
      const both = [guess, other].sort().join("|");
      // Of two guesses, the card asks of the one with handles, the smaller id when both have.
      const [asked, them] = isAskedOf(guess, other)
        ? [guess, other]
        : [other, guess];
      if (
        other !== guess &&
        !pairs.has(both) &&
        !people.isOrganization(other) &&
        !refused.has(`${guess}|${other}`) &&
        handlesOf(asked).length > 0
      ) {
        pairs.set(both, {
          called,
          guess: asked,
          handles: handlesOf(asked),
          lines: [lineOf(asked), lineOf(them)],
          other: them,
        });
      }
    }
  }
  return [...pairs.values()];
}

const shown = (name: string, line: string) =>
  line ? `${name} (${line})` : name;

/** Each pair as its card asks it: the guess's handles, the other as who it may be, each with its line so the two read apart, what joins them (the kind's context, or the name Life knows the other by), the ref bound to both, and both refs for what rides on it. */
export const samePersonAsksOf = (
  people: Pick<People, "nameOf" | "partyOf">,
  pairs: ReturnType<typeof samePersonPairsOf>
) =>
  pairs.map((p) => ({
    about: p.handles,
    ...(p.called && {
      context: `Life knows ${people.nameOf(p.other)} by the name “${p.called}” too; no handle joins them.`,
    }),
    likelyPeople: [people.partyOf(p.other)],
    /** The kept lines about either of them, each once. */
    linesOf: <L>(byRef: ReadonlyMap<string, L[]>) => [
      ...new Set([p.guess, p.other].flatMap((r) => byRef.get(r) ?? [])),
    ],
    question: `Is ${shown(people.nameOf(p.guess), p.lines[0])} the same person as ${shown(people.nameOf(p.other), p.lines[1])}?`,
    ref: samePersonRefOf(p.guess, p.other),
    refs: [p.guess, p.other],
  }));
