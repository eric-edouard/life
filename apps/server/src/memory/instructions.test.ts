import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  type EFFECTS,
  effectOf,
  INSTRUCTIONS,
  inForceOf,
  instructionsFor,
  recordInstruction,
} from "./instructions";

// His instructions: one writer, one reader. Made-up people and projects.

afterEach(() => rmSync(INSTRUCTIONS, { force: true }));

const said = "made-up words of his";

test("the reader holds an instruction to its scope, its `until` and what replaces it", () => {
  const all = recordInstruction({ said, scope: "all", text: "Keep it short" });
  const kit = recordInstruction({
    effect: "no-drafts",
    said,
    scope: "person:kit",
    text: "Never draft to Kit",
  });
  recordInstruction({
    said,
    scope: "project:boat",
    text: "Old",
    until: "2020-01-01T00:00:00.000Z",
  });
  const old = recordInstruction({ said, scope: "matter:m1", text: "Old" });
  const fix = recordInstruction({
    replaces: old.id,
    said,
    scope: "matter:m1",
    text: "New",
  });
  const ids = (s: Parameters<typeof instructionsFor>[0]) =>
    instructionsFor(s).map((i) => i.id);
  expect(ids({})).toEqual([all.id]);
  expect(ids({ people: ["person:kit"] })).toEqual([all.id, kit.id]);
  expect(ids({ people: ["kit"] })).toEqual([all.id, kit.id]);
  expect(ids({ projects: ["boat"] })).toEqual([all.id]);
  expect(ids({ matter: "m1" })).toEqual([all.id, fix.id]);
  expect(() =>
    recordInstruction({ said, scope: "anyone", text: "x" })
  ).toThrow();
});

test("a refusal beats a grant within a scope; the narrowest scope given decides", () => {
  const i = (effect: (typeof EFFECTS)[number], scope: string) => ({
    effect,
    scope,
  });
  expect(effectOf([], "drafts", "no-drafts")).toBeUndefined();
  expect(effectOf([i("drafts", "person:kit")], "drafts", "no-drafts")).toBe(
    true
  );
  expect(
    effectOf(
      [i("drafts", "person:kit"), i("no-drafts", "person:kit")],
      "drafts",
      "no-drafts"
    )
  ).toBe(false);
  expect(
    effectOf(
      [i("no-drafts", "all"), i("drafts", "person:kit")],
      "drafts",
      "no-drafts"
    )
  ).toBe(true);
  expect(
    effectOf(
      [i("drafts", "project:boat"), i("no-drafts", "matter:m1")],
      "drafts",
      "no-drafts"
    )
  ).toBe(false);
});

test("what is in force on every request: the voice, then every style and sensitive instruction, whatever its scope", () => {
  recordInstruction({
    effect: "style",
    said,
    scope: "all",
    text: "Never an emoji",
  });
  recordInstruction({
    effect: "sensitive",
    said,
    scope: "person:kit",
    text: "The lawsuit",
  });
  recordInstruction({
    effect: "hands-off",
    said,
    scope: "project:boat",
    text: "Leave it",
  });
  const block = inForceOf();
  expect(block).toStartWith("Life's voice");
  expect(block).toContain("Never an emoji");
  expect(block).toContain("(person:kit): The lawsuit");
  expect(block).not.toContain("Leave it");
  expect(block).not.toContain("{{owner}}");
});
