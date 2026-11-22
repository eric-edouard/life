import type { Correction, Supersession } from "../records/observation";

// When an observation stops being current: a newer one replaced it, or his word (an `outdated` correction) retired it,
// until his later Reopen of its matter (`matter-reopened`). Pure.

/** A supersession as `observationStatusOf` reads it: a line of supersessions.jsonl, or one his `outdated` correction retires (`outdatedBy`). */
export type Retirement = Omit<Supersession, "madeBy"> & { dropped?: true };

/**
 * Observations a newer one replaced (memory/supersessions.jsonl), or he said are outdated (`by` itself): id -> the first
 * retirement recorded whose `by` is still current (a replacement re-read away no longer retires anything).
 */
export const retiredBy = (list: Retirement[], current: Set<string>) =>
  new Map(
    list
      .filter((s) => current.has(s.by))
      .toReversed() // the first recorded wins: a later entry overwrites
      .map((s): [string, Retirement] => [s.observation, s])
  );

/**
 * What his `outdated` corrections retire (true then, not anymore), as extraction retires a fact later evidence closed:
 * kept as history, not wrong. `by` is the observation itself (no successor: readers of `by` skip it); `why` his words.
 * One his later `matter-reopened` pins is lifted (`reopenedAtOf`): the latest of his words on it wins.
 */
export const outdatedBy = (corrections: Correction[]): Retirement[] => {
  const reopened = reopenedAtOf(corrections);
  return corrections.flatMap((c) =>
    c.kind === "outdated"
      ? c.observations
          .filter((id) => !((reopened.get(id) ?? "") > c.at))
          .map((id) => ({
            at: c.at,
            by: id,
            observation: id,
            schemaVersion: 1 as const,
            validTo: c.at.slice(0, 10), // his word's UTC day (a local day needs zones.ts, which imports this file)
            why: c.note ?? "outdated",
            ...(c.outcome === "dropped" ? { dropped: true as const } : {}),
          }))
      : []
  );
};

/** When he last reopened each step (`matter-reopened`), by its ref: the latest of his Reopens pinning it. Pure. */
export const reopenedAtOf = (corrections: readonly Correction[]) =>
  new Map(
    corrections
      .flatMap((c) =>
        c.kind === "matter-reopened"
          ? c.steps.map((ref): [string, string] => [ref, c.at])
          : []
      )
      .toSorted((a, b) => a[1].localeCompare(b[1])) // the latest last: it overwrites
  );
