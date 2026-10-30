import type { DecisionRow } from "@life/server/src/records/decision";
import { useCallback, useEffect, useRef, useState } from "react";
import { isOpen, moveOf } from "./order";

// Which decision is on screen. The link holds its id (#id), so a reload or a shared link opens on it; a swipe, a tap in
// the overview, an answer or an arrow key moves it.

/** The screen after the last decision he answered. */
export const DONE = "done";

const idOfHash = () => {
  try {
    return decodeURIComponent(globalThis.location.hash.slice(1));
  } catch {
    // A malformed link opens on the first open decision.
    return "";
  }
};
const remember = (id: string) =>
  globalThis.history.replaceState(null, "", `#${encodeURIComponent(id)}`);

/** The current decision among `live`, how to move to one, and the ref each section registers with. */
export function useCurrent(live: DecisionRow[], onMove: () => void) {
  const [wanted, setWanted] = useState(idOfHash);
  const allDone = live.length > 0 && !live.some(isOpen);
  // The link's, while it is still live (or the end, once nothing is open); else the first open one.
  const current =
    live.find((d) => d.id === wanted)?.id ??
    (wanted === DONE && allDone ? DONE : undefined) ??
    (live.find(isOpen) ?? live[0])?.id ??
    "";
  // The end sits after the last one.
  const at =
    current === DONE ? live.length : live.findIndex((d) => d.id === current);

  const go = useCallback(
    (id: string) => {
      setWanted(id);
      onMove();
      remember(id);
      document
        .getElementById(`d-${id}`)
        ?.scrollIntoView({ behavior: "smooth", inline: "start" });
    },
    [onMove]
  );

  // On the first load (and when the one he was on closes), the row opens on the current one.
  const shown = useRef("");
  useEffect(() => {
    if (current && current !== shown.current) {
      shown.current = current;
      document
        .getElementById(`d-${current}`)
        ?.scrollIntoView({ behavior: "instant", inline: "start" });
    }
  }, [current]);

  // A swipe that settles on another decision makes it the current one: the one most of the screen shows
  // (an IntersectionObserver, not `scrollend`, which iOS Safari may not fire). Each section registers itself.
  const seen = useRef<IntersectionObserver>(null);
  const watch = useCallback((section: HTMLElement | null) => {
    if (!section) {
      return;
    }
    seen.current ??= new IntersectionObserver(
      (entries) => {
        const id = entries.find((e) => e.isIntersecting)?.target.id.slice(2);
        if (id && id !== shown.current) {
          shown.current = id;
          setWanted(id);
          remember(id);
        }
      },
      { threshold: 0.6 }
    );
    const observer = seen.current;
    observer.observe(section);
    return () => observer.unobserve(section);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const by = moveOf(e.key, e.target);
      const to = by
        ? (live[at + by]?.id ??
          (at + by === live.length && allDone ? DONE : undefined))
        : undefined;
      if (to) {
        go(to);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [at, live, allDone, go]);

  return { allDone, current, go, watch };
}
