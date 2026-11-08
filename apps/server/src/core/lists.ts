// Lists cut to a size: by a budget, or a page by whole keys.

/** The first items of `list` whose sizes add up to `budget` at most. */
export function within<T>(list: T[], budget: number, size: (x: T) => number) {
  let used = 0;
  return list.filter((x) => {
    used += size(x);
    return used <= budget;
  });
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
