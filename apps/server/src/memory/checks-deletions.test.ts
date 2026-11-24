import { expect, test } from "bun:test";
import { checksOf } from "./checks";
import { decision, inputs, line } from "./checks-test-inputs";

// What he deleted never comes back as a card (docs/glossary.md, "deletion"): not the card itself, not one on its step.

test("a card he deleted what it rests on never shows: not its own ref, not its step's", () => {
  const o = line({ text: "Send the quote." });
  const cards = [
    decision("dec_0000000000aa", "2026-11-20T09:00:00.000Z"),
    decision("dec_0000000000bb", "2026-11-20T09:00:00.000Z", o.id),
  ];
  const shown = (deleted: string[]) =>
    checksOf(inputs([o], { decisions: cards, deleted: new Set(deleted) }))
      .filter((c) => c.kind === "decision")
      .map((c) => c.ref);
  expect(shown([])).toEqual(["dec_0000000000aa", "dec_0000000000bb"]);
  expect(shown(["dec_0000000000aa"])).toEqual(["dec_0000000000bb"]);
  // Its step deleted (the fact it rides on): gone too.
  expect(shown([o.id])).toEqual(["dec_0000000000aa"]);
});
