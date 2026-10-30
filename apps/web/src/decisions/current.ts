import type { DecisionRow } from "@life/server/src/records/decision";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentOf, DONE, isOpen, moveOf } from "./order";

// Which decision is on screen. The link holds its id (#id), so a reload or a shared link opens on it; a swipe, a tap in
// the overview, an answer or an arrow key moves it.

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
const sectionOf = (id: string) => document.getElementById(`d-${id}`);
/** Whether most of the section fills the screen, as a swipe counts it. */
const isOnScreen = (section: HTMLElement) => {
  const r = section.getBoundingClientRect();
  const seen = Math.min(r.right, globalThis.innerWidth) - Math.max(r.left, 0);
  return seen >= 0.6 * r.width;
};

/** The current decision among `live`, how to move to one, and the ref each section registers with. */
export function useCurrent(live: DecisionRow[], onMove: () => void) {
  const [wanted, setWanted] = useState(idOfHash);
  const allDone = live.length > 0 && !live.some(isOpen);
  const current = currentOf(live, wanted);
  // The end sits after the last one.
  const at =
    current === DONE ? live.length : live.findIndex((d) => d.id === current);
  // What is on screen now, and where a smooth move is headed (the sections it passes on the way don't count).
  const shown = useRef("");
  const heading = useRef("");

  const go = useCallback(
    (id: string) => {
      onMove();
      remember(id);
      shown.current = id;
      setWanted(id);
      const section = sectionOf(id);
      // Only a real move has sections to pass: one already on screen, or not drawn yet, has none.
      if (section && !isOnScreen(section)) {
        heading.current = id;
        section.scrollIntoView({ behavior: "smooth", inline: "start" });
      }
    },
    [onMove]
  );

  // On the first load, and when the one on screen closes, the row jumps to the current one.
  useEffect(() => {
    if (current && current !== shown.current) {
      shown.current = current;
      sectionOf(current)?.scrollIntoView({
        behavior: "instant",
        inline: "start",
      });
    }
  }, [current]);

  // A swipe that settles on another decision makes it the current one: the one that fills most of the screen (an
  // IntersectionObserver, not `scrollend`, which iOS Safari may not fire). Each section registers itself.
  const seen = useRef<IntersectionObserver>(null);
  const watch = useCallback((section: HTMLElement | null) => {
    if (!section) {
      return;
    }
    seen.current ??= new IntersectionObserver(
      (entries) => {
        const id = entries
          .find((e) => e.intersectionRatio >= 0.6)
          ?.target.id.slice(2);
        if (!id || (heading.current !== "" && id !== heading.current)) {
          return;
        }
        heading.current = "";
        if (id !== shown.current) {
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

  // His own touch, wheel or key takes over from a move: where he lands is where he is.
  useEffect(() => {
    const yours = () => {
      heading.current = "";
    };
    const events = ["pointerdown", "wheel", "keydown"] as const;
    for (const e of events) {
      document.addEventListener(e, yours, { capture: true, passive: true });
    }
    return () => {
      for (const e of events) {
        document.removeEventListener(e, yours, { capture: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const by = moveOf(e.key, e.target);
      const to =
        live[at + by]?.id ??
        (at + by === live.length && allDone ? DONE : undefined);
      if (by && to) {
        go(to);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [at, live, allDone, go]);

  return { allDone, current, go, watch };
}
