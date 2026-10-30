import { type RefObject, useLayoutEffect, useState } from "react";

// How dense a decision must be to fit the screen, without anything scrolling inside it:
// 0 as written; 1 consequences on one line; 2 consequences in the sheet, the preview shorter;
// 3 the question a step smaller, the preview a link. Past 3 the decision scrolls as one.
const DENSEST = 3;

/** The lightest density at which `el` holds its content, measured again whenever its height changes. */
export function useDensity(el: RefObject<HTMLElement | null>) {
  const [dense, setDense] = useState(0);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const e = el.current;
    if (!e) {
      return;
    }
    const seen = new ResizeObserver(() => setHeight(e.clientHeight));
    seen.observe(e);
    return () => seen.disconnect();
  }, [el]);
  // A new height (the keyboard, a rotation) starts again from the lightest.
  useLayoutEffect(() => {
    if (height) {
      setDense(0);
    }
  }, [height]);
  // One step at a time, before paint, until it fits.
  useLayoutEffect(() => {
    const e = el.current;
    if (e && dense < DENSEST && e.scrollHeight > e.clientHeight + 1) {
      setDense(dense + 1);
    }
  });
  return dense;
}
