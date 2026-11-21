import { expect, test } from "bun:test";
import { preTickedOf } from "./life-checks";

test("the pre-ticked answer: an ending is done; a voice of no one known heard once with no name is not named; nothing else", () => {
  const heard = (
    kind: "known_person" | "new_person",
    conversations: number,
    name: string | null
  ) => ({ conversations, kind, name });
  const asked = { kind: "voice" as const };
  expect(preTickedOf({ kind: "ending" })).toBe("outdated");
  expect(preTickedOf({ kind: "person" })).toBeNull();
  expect(preTickedOf(asked, heard("new_person", 1, null))).toBe("not-relevant");
  expect(preTickedOf(asked, heard("new_person", 1, "Zed"))).toBeNull();
  expect(preTickedOf(asked, heard("new_person", 2, null))).toBeNull();
  // A known person's own name or alias is never in `name`: heard once, it is still no voice to drop.
  expect(preTickedOf(asked, heard("known_person", 1, null))).toBeNull();
  // "Yes" waits for lifelog's likeness: a guess named by the name it was found by is not ticked.
  expect(preTickedOf(asked, heard("known_person", 4, "Dana"))).toBeNull();
});
