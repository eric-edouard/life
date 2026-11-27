import { expect, test } from "bun:test";
import { dragOf, isClosingDrag } from "./sheet";

test("a swipe closes the sheet only once dragged far enough down", () => {
  expect(dragOf(100, 60)).toBe(0);
  expect(isClosingDrag(dragOf(100, 150))).toBe(false);
  expect(isClosingDrag(dragOf(100, 200))).toBe(true);
});
