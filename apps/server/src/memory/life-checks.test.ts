import { expect, test } from "bun:test";
import { preTickedOf } from "./life-checks";

test("the pre-ticked answer: an ending is done; a backed guess in use is them; a voice of no one known heard once with no name is not named; nothing else", () => {
  const heard = (
    kind: "known_person" | "new_person",
    conversations: number,
    name: string | null
  ) => ({ conversations, kind, name });
  const asked = { kind: "voice" as const };
  expect(preTickedOf({ kind: "ending" })).toBe("outdated");
  expect(preTickedOf({ kind: "person" })).toBeNull();
  // Yes on a guess in use and on two accounts that may be one person; a name Life cannot place has no guess to affirm.
  expect(preTickedOf({ group: "guessed person", kind: "person" })).toBe(
    "this-is"
  );
  expect(preTickedOf({ group: "same person", kind: "person" })).toBe(
    "same-person"
  );
  expect(preTickedOf({ group: "name", kind: "person" })).toBeNull();
  expect(preTickedOf(asked, heard("new_person", 1, null))).toBe("not-relevant");
  expect(preTickedOf(asked, heard("new_person", 1, "Zed"))).toBeNull();
  expect(preTickedOf(asked, heard("new_person", 2, null))).toBeNull();
  // A known person's own name or alias is never in `name`: heard once, it is still no voice to drop.
  expect(preTickedOf(asked, heard("known_person", 1, null))).toBeNull();
  // "Yes" only on a guess in use that is backed (`subject` given only then: `isSuggestionBackedOf`).
  expect(preTickedOf(asked, heard("known_person", 4, "Dana"))).toBeNull();
  const guess = { kind: "voice" as const, subject: "person:dana" };
  expect(preTickedOf(guess, heard("known_person", 4, null))).toBe("is-them");
});
