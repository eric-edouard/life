// Life's events in a calendar, as both its calendars draft them (the Past calendar's episodes, `past-events.ts`; the
// appointments, `host/appointments-calendar.ts`), and the one rule that brings a calendar in line with its drafts.

/** One event Life wants in a calendar, before the IO-bound part of its description. */
export interface Draft {
  allDay: boolean;
  /** RFC3339 instants, or YYYY-MM-DD days (end exclusive) when `allDay`. */
  from: string;
  /** Over everything it shows: an event written with another hash is written again. */
  hash: string;
  /** The id of what it shows: an episode or an appointment. */
  of: string;
  place: string | null;
  summary: string;
  text: string;
  to: string;
}

/** Life's events in a calendar, by what they show: each one's id there and the hash it was written with. */
export type Held = Map<string, { hash?: string; id: string }[]>;

/** Life's events listed from a calendar, grouped by what they show. */
export const heldOf = (
  rows: { hash?: string; id: string; of: string }[]
): Held =>
  new Map(
    [...Map.groupBy(rows, (r) => r.of)].map(([of, rs]) => [
      of,
      rs.map(({ hash, id }) => ({ hash, id })),
    ])
  );

/**
 * What a sync does: create each draft with no event, update in place the one whose hash changed, remove any second
 * copy and the events of what is no longer drafted, except those `isKept` says stay (outside the sync's window).
 */
export function reconcile<D extends Draft>(
  want: D[],
  held: Held,
  isKept: (of: string) => boolean = () => false
) {
  const drafted = new Set(want.map((d) => d.of));
  const create: D[] = [];
  const update: { d: D; id: string }[] = [];
  const remove: { id: string; of: string }[] = [];
  for (const d of want) {
    const [e, ...more] = held.get(d.of) ?? [];
    if (!e) {
      create.push(d);
    } else if (e.hash !== d.hash) {
      update.push({ d, id: e.id });
    }
    remove.push(...more.map(({ id }) => ({ id, of: d.of })));
  }
  for (const [of, events] of held) {
    if (!(drafted.has(of) || isKept(of))) {
      remove.push(...events.map(({ id }) => ({ id, of })));
    }
  }
  return { create, remove, update };
}
