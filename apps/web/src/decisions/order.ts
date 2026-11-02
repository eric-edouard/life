import type { Decision } from "@life/server/src/records/decision";

// The decisions page's order and its answer rules, pure. Life's fact checks by deadline; closed ones under History.

type D = Pick<Decision, "answer" | "status">;

/** His answer once his note changes: an option he tapped stays; a note alone answers; clearing it reopens. */
export function noteAnswer(d: D, note: string) {
  const tapped = d.answer && d.answer !== "note" ? d.answer : null;
  if (tapped) {
    return tapped;
  }
  return note ? "note" : null;
}

/** Still his to answer: open, with no answer yet. */
export const isOpen = (d: D) => d.status === "open" && !d.answer;

/** His live decisions by deadline, and his closed ones newest first. */
export const orderOf = (decisions: Decision[]) => ({
  live: decisions
    .filter((d) => !d.closedAt)
    .sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9")),
  past: decisions
    .filter((d) => d.closedAt)
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")),
});

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
export function currentOf(live: Decision[], wanted: string) {
  const allDone = live.length > 0 && !live.some(isOpen);
  return (
    live.find((d) => d.id === wanted)?.id ??
    (wanted === DONE && allDone ? DONE : undefined) ??
    (live.find(isOpen) ?? live[0])?.id ??
    ""
  );
}
