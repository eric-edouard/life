import { expect, test } from "bun:test";
import { nextOf } from "./sign-in";

test("after sign-in he goes back only to a path on this site", () => {
  expect(nextOf("/me/sam")).toBe("/me/sam");
  expect(nextOf("/decisions#lynx-20261030080000-1")).toBe(
    "/decisions#lynx-20261030080000-1"
  );
  for (const away of [
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "https://evil.example",
    3,
    undefined,
  ]) {
    expect(nextOf(away)).toBe("/decisions");
  }
});
