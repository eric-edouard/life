import { expect, test } from "bun:test";
import { isSameBirthday } from "./fields";

test("two birthdays are the same day: month and day equal, the years too when both are known", () => {
  for (const [a, b, same] of [
    ["1980-03-14", "--03-14", true],
    ["1980-03-14", "1980-03-14", true],
    ["1980-03-14", "1981-03-14", false],
    ["1980-03-14", "1980-03-15", false],
    ["--03-14", "--04-14", false],
    ["--02-29", "2000-02-29", true],
  ] as const) {
    expect(isSameBirthday(a, b)).toBe(same);
  }
});
