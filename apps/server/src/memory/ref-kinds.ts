import { rowsOf } from "../core/files";
import {
  Closeness,
  type Correction,
  INFERRED_PREFIX,
  INFERRED_USE_AT,
  type InferredPerson,
  isSettledGuess,
} from "../records/observation";
import type { Organization } from "../records/truth";
import { CLOSENESS, latestBy } from "./memory-files";

// What a person ref (as folded today) is, by one rule each: only a guess, someone he knows, an organization.
// `readPeople` (who.ts) gives them over its reads; personal steps skip organizations.

/** Each inferred ref's latest record in use (at or above INFERRED_USE_AT): it decides, as in reading it (`guessesOf`). */
export const latestInUseOf = <
  R extends Pick<InferredPerson, "confidence" | "id">,
>(
  inferred: R[]
) =>
  new Map(
    inferred
      .filter((r) => r.confidence >= INFERRED_USE_AT)
      .map((r) => [`person:${r.id}`, r])
  );

/** The refs his word named: `this-is` to them, or `same-person` into them. */
const saidOf = (corrections: Correction[]) =>
  new Set(
    corrections.flatMap((c) => {
      if (c.kind === "this-is") {
        return [c.person];
      }
      return c.kind === "same-person" ? [c.to] : [];
    })
  );

const isInferred = (ref: string) => ref.startsWith(`person:${INFERRED_PREFIX}`);

/**
 * The test for "this person ref (as folded today) is only a guess": an inferred person his word has not named, whose
 * latest record in use (`latestInUseOf`) is not settled (`isSettledGuess`). `this-is` or `same-person` to it confirms it. A `not-this-person` refuses one name or handle of it, not the person: one that
 * holds another handle is still a guess. The one rule (`isGuess` on `readPeople`, so `guessedOf` and the person checks
 * agree).
 */
export function guessTestOf(
  corrections: Correction[],
  latest: Map<string, Pick<InferredPerson, "confidence" | "isOrganization">>
) {
  const said = saidOf(corrections);
  return (ref: string) => {
    const r = latest.get(ref);
    return isInferred(ref) && !said.has(ref) && !(r && isSettledGuess(r));
  };
}

/**
 * The test for "someone he knows" (a person ref as folded today): anyone not inferred by Life (his directory, a
 * person or an organization, and his Contacts), or an inferred one his word named (`this-is`, `same-person`). A guess,
 * however sure, and an inferred organization he never named are not. The one rule (`isKnownToHim` on `readPeople`).
 */
export const knownTestOf = (corrections: Correction[]) => {
  const said = saidOf(corrections);
  return (ref: string) => !isInferred(ref) || said.has(ref);
};

/** Each person's latest closeness judgment (`closeness.jsonl`). */
export const readCloseness = () =>
  latestBy(rowsOf(CLOSENESS, Closeness), (c) => c.person);

/**
 * The test for "this ref (as folded today) is an organization", the one rule: one of his directory's organizations, else
 * its latest inferred record in use says so, else closeness judged it a service (read only then: `readRows`) and his
 * own `closeness` word does not cover it.
 */
export function organizationTestOf(
  organizations: Pick<Organization, "id">[],
  latest: Map<string, Pick<InferredPerson, "isOrganization">>,
  {
    canon,
    corrections,
  }: { canon: (ref: string) => string; corrections: Correction[] },
  readRows = readCloseness
) {
  const directory = new Set(organizations.map((o) => `person:${o.id}`));
  let services: Set<string> | undefined;
  const servicesNow = () => {
    services ??= new Set(
      [...readRows().values()].flatMap((c) =>
        c.service && canon(c.person) === c.person ? [c.person] : []
      )
    ).difference(
      new Set(
        corrections.flatMap((c) =>
          c.kind === "closeness" ? [canon(c.person)] : []
        )
      )
    );
    return services;
  };
  return (ref: string) =>
    directory.has(ref) ||
    latest.get(ref)?.isOrganization === true ||
    servicesNow().has(ref);
}
