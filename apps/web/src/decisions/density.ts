import { type RefObject, useCallback, useLayoutEffect, useState } from "react";

// How dense a decision must be to fit the screen, without anything scrolling inside it:
// 0 as written; 1 the preview shorter; 2 the question a step smaller, the preview a link. Past 2 the decision scrolls
// as one.
export const DENSEST = 2;

/**
 * The lightest density at which `el` holds its content: measured again when its size changes (the keyboard, a
 * rotation, a window) and when `remeasure` is called (a fold has finished moving).
 */
export function useDensity(el: RefObject<HTMLElement | null>) {
  const [dense, setDense] = useState(0);
  const [size, setSize] = useState("");
  useLayoutEffect(() => {
    const e = el.current;
    if (!e) {
      return;
    }
    const seen = new ResizeObserver(() =>
      setSize(`${e.clientWidth}x${e.clientHeight}`)
    );
    seen.observe(e);
    return () => seen.disconnect();
  }, [el]);
  // A new size starts again from the lightest.
  useLayoutEffect(() => {
    if (size) {
      setDense(0);
    }
  }, [size]);
  // One step at a time, before paint, until it fits.
  useLayoutEffect(() => {
    const e = el.current;
    if (e && dense < DENSEST && e.scrollHeight > e.clientHeight + 1) {
      setDense(dense + 1);
    }
  });
  const remeasure = useCallback(() => setDense(0), []);
  return [dense, remeasure] as const;
}
