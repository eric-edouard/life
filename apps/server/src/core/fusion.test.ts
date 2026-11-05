import { expect, test } from "bun:test";
import { fuse } from "./fusion";

test("an item both rankings found beats one only the first found", () => {
  expect(fuse([["a", "b"], ["b"]]).map(([id]) => id)).toEqual(["b", "a"]);
  expect(fuse([["a"], []]).map(([id]) => id)).toEqual(["a"]);
});
