import { expect, test } from "bun:test";
import { failingParts } from "./messaging-status";

test("a card shows a stopped bridge, never its reading", () => {
  const health = {
    detail: "",
    ok: false,
    parts: [
      { kind: "bridge" as const, ok: false, text: "bridge stopped" },
      { kind: "read" as const, ok: false, text: "read failed" },
    ],
  };
  expect(failingParts(health).map((p) => p.text)).toEqual(["bridge stopped"]);
  expect(failingParts(undefined)).toEqual([]);
});
