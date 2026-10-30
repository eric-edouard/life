import type { DecisionRow } from "@life/server/src/records/decision";

// The decisions page's order and its answer rules, pure. Loops in his goals' order, each by deadline; closed ones
// under History.

type D = Pick<DecisionRow, "answer" | "status" | "options">;

/** His answer once his note changes: an option he tapped stays; a note alone answers; clearing it reopens. */
export function noteAnswer(d: D, note: string) {
  const tapped = d.answer && d.answer !== "note" ? d.answer : null;
  if (tapped) {
    return tapped;
  }
  return note ? "note" : null;
}

/** His answer when he taps an option: tapping the one already chosen takes it back (his note, if any, then answers). */
export function tapAnswer(d: D, option: string, note: string) {
  if (d.answer !== option) {
    return option;
  }
  return note ? "note" : null;
}

/** Still his to answer: open, with no answer yet, and something to answer (a request of his has nothing). */
export const isOpen = (d: D) =>
  d.status === "open" && !d.answer && d.options.length > 0;

export interface Loop {
  grants: DecisionRow[];
  live: DecisionRow[];
  loop: string;
  past: DecisionRow[];
}

/**
 * The loops in his goals' order (the lowest rank among a loop's open decisions), then the most open, then by name;
 * each with its live decisions by deadline, its closed ones newest first, and its standing grants.
 */
export function orderOf(decisions: DecisionRow[]): Loop[] {
  const openOf = (l: string) =>
    decisions.filter((d) => d.loop === l && d.status === "open");
  const rank = (l: string) =>
    Math.min(99, ...openOf(l).map((d) => d.rank ?? 99));
  return [...new Set(decisions.map((d) => d.loop))]
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        openOf(b).length - openOf(a).length ||
        a.localeCompare(b)
    )
    .map((loop) => {
      const mine = decisions.filter((d) => d.loop === loop);
      return {
        grants: mine.filter((d) => d.active),
        live: mine
          .filter((d) => !d.closedAt)
          .sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9")),
        loop,
        past: mine
          .filter((d) => d.closedAt)
          .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")),
      };
    });
}

/** The next decision still his to answer after `id`, wrapping round; none when all are answered. */
export function nextOpen<T extends D & { id: string }>(live: T[], id: string) {
  const at = live.findIndex((d) => d.id === id);
  const after = [...live.slice(at + 1), ...live.slice(0, Math.max(at, 0))];
  return after.find(isOpen);
}

/** Escape closes the overview; every other key is left alone (30 Oct: a handler cancelling them stopped his typing). */
export function keyDown(e: Pick<KeyboardEvent, "key">, close: () => void) {
  if (e.key === "Escape") {
    close();
  }
}
