import type { Observation } from "../records/observation";
import { eventKey } from "../records/source";
import type { observationStatusOf } from "./memory-files";

// A unit read again (a prompt bump, a grown chat) or regrouped away gives its facts new ids (docs/glossary.md,
// "succeeds"): each current fact citing the same source line takes its earlier readings' places in their matters, what
// a matters call was shown of them, and their endings. Derived when read, never stored. Pure.

/** A current observation and the earlier readings of its line it takes over (`succeedsOf`). */
export interface Succeeding {
  succeeds?: readonly string[];
}

/** Where an earlier reading of a line stands once its unit was read again (`replaced`) or regrouped away (`gone`): never an ending, his word or a retirement. */
export const READ_AGAIN: ReturnType<typeof observationStatusOf>["state"][] = [
  "gone",
  "replaced",
];

/**
 * Gives each observation that takes over earlier readings (`succeeds`) the first of their endings in `endings`, when it
 * has none of its own: unless his Reopen of it came at or after that ending (the latest of his words wins), or the
 * ending is its own replacement by itself.
 */
export function inheritEndings<T extends { at: string; replacedBy?: string }>(
  endings: Map<string, T>,
  observations: readonly (Succeeding & { id: string })[],
  reopenedAt: ReadonlyMap<string, string> = new Map()
) {
  for (const o of observations) {
    const was = o.succeeds
      ?.map((id) => endings.get(id))
      .find(
        (e) =>
          e !== undefined &&
          e.replacedBy !== o.id &&
          !(Date.parse(reopenedAt.get(o.id) ?? "") >= Date.parse(e.at))
      );
    if (was && !endings.has(o.id)) {
      endings.set(o.id, was);
    }
  }
}

/**
 * Each current observation with the earlier readings of its source line it takes over (`succeeds`), only where it is
 * plain which (an ambiguous one takes over nothing, and the night places it afresh): the one current fact on its line
 * takes over every earlier one there; of several, each takes over the earlier ones of its kind when it is that line's
 * only current fact of its kind. Lines are compared by `eventKey`. Pure.
 */
export function succeedsOf<
  O extends Pick<Observation, "id" | "source" | "type">,
>(
  current: readonly O[],
  earlier: readonly Pick<Observation, "id" | "source" | "type">[]
): (O & Succeeding)[] {
  const lineOf = (o: Pick<Observation, "source">) =>
    eventKey({ id: o.source.ref, source: o.source.channel });
  const before = Map.groupBy(earlier, lineOf);
  const now = Map.groupBy(current, lineOf);
  return current.map((o) => {
    const mates = now.get(lineOf(o)) ?? [];
    const sameKind = mates.filter((m) => m.type === o.type).length === 1;
    const succeeds = (before.get(lineOf(o)) ?? [])
      .filter((e) => mates.length === 1 || (sameKind && e.type === o.type))
      .map((e) => e.id)
      .filter((id) => id !== o.id);
    return succeeds.length > 0 ? { ...o, succeeds } : o;
  });
}

/** Each earlier reading's successors, by its id. */
export const successorsOf = (
  observations: readonly (Succeeding & { id: string })[]
) =>
  new Map(
    [
      ...Map.groupBy(
        observations.flatMap((o) =>
          (o.succeeds ?? []).map((was) => ({ id: o.id, was }))
        ),
        (s) => s.was
      ),
    ].map(([was, list]) => [was, list.map((s) => s.id)])
  );

/** What a matters call was shown (`mattersNow`'s `offered`), and each observation taking over an offered one (`succeeds`): the one test of "offered", for the book and the night's matters step. Pure. */
export const offeredNowOf = (
  offered: ReadonlySet<string>,
  observations: readonly (Succeeding & { id: string })[]
): ReadonlySet<string> =>
  new Set([
    ...offered,
    ...observations.flatMap((o) =>
      o.succeeds?.some((id) => offered.has(id)) ? [o.id] : []
    ),
  ]);
