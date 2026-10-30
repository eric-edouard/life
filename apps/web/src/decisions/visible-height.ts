import { useEffect, useState } from "react";

/**
 * The height he can see: the Visual Viewport's, which shrinks under the phone's keyboard (iOS Safari keeps the layout
 * viewport and has no `interactive-widget`), so nothing on the page sits under the keyboard or Safari's bar.
 */
export function useVisibleHeight() {
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const vv = globalThis.visualViewport;
    if (!vv) {
      return;
    }
    const update = () => {
      // Pinch-zoom shrinks the visual viewport too: the shell keeps the layout's height then, and his place.
      setHeight(vv.height * vv.scale);
      if (vv.scale === 1) {
        // iOS pans the page up to show a focused field; the shell already fits above the keyboard.
        globalThis.scrollTo(0, 0);
      }
    };
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);
  return height;
}
