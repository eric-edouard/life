import { latestInUseOf } from "./ref-kinds";
import { nameKey } from "./units";
import type { People } from "./who";

// The likely matches the folds leave (life#727): a guess Life uses and someone else going by its whole name, never
// joined by a fact. Asked as one card ("Are these the same person?"), never decided by Life; worked out when the inbox
// is read, never stored.

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

/**
 * Each guess in use (`isGuess`: not settled, not his word), not folded, not an organization, with a handle, and someone
 * else going by its whole name: his directory (a name or an alias), his Contacts, or another such guess (one card for
 * the two, asked of the one with handles, the smaller id when both have). A pair his word settled is never asked
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
  const handlesOf = (ref: string) => {
    const g = guesses.get(ref);
    return (g?.namesAndHandles ?? []).filter(
      (h) => HANDLE.test(h) && nameKey(h) !== nameKey(g?.name ?? "")
    );
  };
  const lineOf = new Map<string, string>([
    ...people.contacts.map(
      (c) => [`person:${c.id}`, "in his Contacts"] as const
    ),
    ...people.truth.people.map(
      (p) => [`person:${p.id}`, p.relation ?? "in his directory"] as const
    ),
    ...[...guesses].map(([ref, g]) => {
      const [handle] = handlesOf(ref);
      return [ref, handle ? `${g.relation}, ${handle}` : g.relation] as const;
    }),
  ]);
  const byName = Map.groupBy(
    [
      ...people.truth.people.flatMap((p) =>
        [p.name, ...p.aliases].map((n) => ({ n, ref: `person:${p.id}` }))
      ),
      ...people.contacts.map((c) => ({ n: c.name, ref: `person:${c.id}` })),
      ...[...guesses].map(([ref, g]) => ({ n: g.name, ref })),
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
    { guess: string; handles: string[]; lines: [string, string]; other: string }
  >();
  for (const [guess, g] of guesses) {
    for (const { ref } of isWholeName(g.name)
      ? (byName.get(nameKey(g.name)) ?? [])
      : []) {
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
          guess: asked,
          handles: handlesOf(asked),
          lines: [lineOf.get(asked) ?? "", lineOf.get(them) ?? ""],
          other: them,
        });
      }
    }
  }
  return [...pairs.values()];
}

/** Each pair as its card asks it: the guess's handles, the other as who it may be, each with its line so the two read apart, the ref bound to both, and both refs for what rides on it. */
export const samePersonAsksOf = (
  people: Pick<People, "nameOf" | "partyOf">,
  pairs: ReturnType<typeof samePersonPairsOf>
) =>
  pairs.map((p) => ({
    about: p.handles,
    likelyPeople: [people.partyOf(p.other)],
    /** The kept lines about either of them, each once. */
    linesOf: <L>(byRef: ReadonlyMap<string, L[]>) => [
      ...new Set([p.guess, p.other].flatMap((r) => byRef.get(r) ?? [])),
    ],
    question: `Is ${people.nameOf(p.guess)} (${p.lines[0]}) the same person as ${people.nameOf(p.other)} (${p.lines[1]})?`,
    ref: samePersonRefOf(p.guess, p.other),
    refs: [p.guess, p.other],
  }));
