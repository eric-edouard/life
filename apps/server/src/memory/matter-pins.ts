import type { IconPin, ImportantPin, ProjectPin } from "../records/matter";

// His pins on a matter (and Life's directions, `directionsOf`): each found by its steps, so a re-group keeps it, the
// latest for a matter winning. Pure.

/** A matter as a pin finds it: its id and its steps. */
export interface Found {
  id: string;
  steps: readonly { ref: string }[];
}

/** A book's matter finder (`matterFinderOf`), built once per book read and shared by every pin kind. */
export type Finder<V> = (
  refs: readonly string[],
  prefer?: string
) => V | undefined;

/**
 * Each pin of his or Life's, oldest first, with the matter `find` finds by its steps (so a re-group keeps it); the
 * matter's id when written only breaks a tie (between matters holding as many of its steps, the one picked); a pin no
 * matter holds is left out. Pure.
 */
export function pinnedOf<
  V extends Found,
  P extends { at: string; matter?: string; steps: readonly string[] },
>(find: Finder<V>, pins: readonly P[]) {
  return pins
    .toSorted((a, b) => a.at.localeCompare(b.at))
    .flatMap((p) => {
      const v = find(p.steps, p.matter);
      return v ? [[v, p] as const] : [];
    });
}

/** The ids of the matters `find` finds that his marks hold important (`pinnedOf`): the latest for a matter wins. Pure. */
export function importantIdsOf<V extends Found>(
  find: Finder<V>,
  pins: readonly ImportantPin[]
) {
  const marked = new Map(
    pinnedOf(find, pins).map(([v, p]) => [v.id, p.important])
  );
  return new Set([...marked].flatMap(([id, on]) => (on ? [id] : [])));
}

/** His project for each matter `find` finds (`pinnedOf`), by id: the latest pin for a matter wins. Pure. */
export const chosenProjectsOf = <V extends Found>(
  find: Finder<V>,
  pins: readonly ProjectPin[]
) => new Map(pinnedOf(find, pins).map(([v, p]) => [v.id, p.project]));

/** His icon for each matter `find` finds (`pinnedOf`), by id: the latest pin for a matter wins; null gives it back to Life. Pure. */
export const chosenIconsOf = <V extends Found>(
  find: Finder<V>,
  pins: readonly IconPin[]
) => new Map(pinnedOf(find, pins).map(([v, p]) => [v.id, p.icon]));

/** The ids of the matters he dismissed as new matter checks, each found (`find`, over the whole book, so the hand-out, the new matter check and the report agree) by the steps it was pinned to (`pins`). Pure. */
export const dismissedIdsOf = (
  find: Finder<Found>,
  pins: readonly (readonly string[])[]
) => new Set(pins.flatMap((p) => find(p)?.id ?? []));
