import { daysBefore } from "./clock";

// Lists cut to a size: by a budget, or a page by whole keys; and a size said in words.

/** "1 commit", "2 commits". */
export const count = (n: number, noun: string) =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The first items of `list` whose sizes add up to `budget` at most. */
export function within<T>(list: T[], budget: number, size: (x: T) => number) {
  let used = 0;
  return list.filter((x) => {
    used += size(x);
    return used <= budget;
  });
}

/**
 * The items a night takes, the newest first (`at`, a string that sorts by time), while their `size`s fit `cap`. An item
 * too big for what is left waits; a smaller, older one still goes.
 */
export function newestWithin<P>(
  pending: P[],
  cap: number,
  o: { at: (p: P) => string; size: (p: P) => number }
) {
  const taken: P[] = [];
  let room = cap;
  for (const p of pending.toSorted((a, b) => o.at(b).localeCompare(o.at(a)))) {
    if (o.size(p) <= room) {
      taken.push(p);
      room -= o.size(p);
    }
  }
  return taken;
}

/**
 * The items whose day (`YYYY-MM-DD`) is within `days` days of the newest item's day, that day included: a window that
 * ends at the subject's newest evidence, never at today, so the clock moving alone changes nothing.
 */
export function endingAtNewest<T>(
  items: T[],
  dayOf: (x: T) => string,
  days: number
) {
  const newest = items.map(dayOf).reduce((a, d) => (d > a ? d : a), "");
  if (!newest) {
    return [];
  }
  const from = daysBefore(newest, days);
  return items.filter((x) => dayOf(x) >= from);
}

/**
 * A list packed in order into groups whose sizes add up to `budget` at most. An item is never split: one over the
 * budget is a group alone.
 */
export function packed<T>(list: T[], budget: number, size: (x: T) => number) {
  const out: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const x of list) {
    const n = size(x);
    if (current.length > 0 && used + n > budget) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(x);
    used += n;
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

/**
 * A page of a list ordered newest first, by whole keys (a day, an instant): the newest items before `before` up to
 * `limit`, then the rest of the last key taken, so a key is never cut between two pages. `next`: the key to page back
 * from, when something older is left.
 */
export function newestDays<T>(
  items: T[],
  keyOf: (x: T) => string,
  limit: number,
  before?: string
) {
  const left = before ? items.filter((x) => keyOf(x) < before) : items;
  const edge = left[limit - 1];
  const taken = edge
    ? left.filter((x) => keyOf(x) >= keyOf(edge))
    : left.slice();
  const last = taken.at(-1);
  return {
    next: last && taken.length < left.length ? keyOf(last) : undefined,
    taken,
  };
}
