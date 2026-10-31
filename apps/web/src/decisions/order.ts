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

/**
 * Which way a key moves through his decisions: the arrows, never while he types, never any other key (30 Oct: a key
 * handler that cancelled every key stopped his typing; this one only reads them).
 */
export function moveOf(key: string, target: EventTarget | null) {
  // A sheet open on top keeps the row where it is.
  if (
    (target as Element | null)?.closest?.("textarea, input") ||
    globalThis.document?.querySelector('[role="dialog"]')
  ) {
    return 0;
  }
  return ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[key] ?? 0;
}

/** The screen after the last decision he answered. */
export const DONE = "done";

/** The decision on screen: the one `wanted`, while it is live (or the end, once nothing is open); else the first open one. */
export function currentOf(live: DecisionRow[], wanted: string) {
  const allDone = live.length > 0 && !live.some(isOpen);
  return (
    live.find((d) => d.id === wanted)?.id ??
    (wanted === DONE && allDone ? DONE : undefined) ??
    (live.find(isOpen) ?? live[0])?.id ??
    ""
  );
}
