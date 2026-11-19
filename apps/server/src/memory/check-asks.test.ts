import { expect, test } from "bun:test";
import { cardAskOf, guessAskOf, personQuestionOf } from "./check-asks";

test("the question names the first name, both of a card's people, or a description whole", () => {
  expect(personQuestionOf(["Kit Moreau"])).toBe("Is this Kit?");
  expect(personQuestionOf(["Gran", "Robin Vale"])).toBe(
    "Is this Gran or Robin?"
  );
  expect(personQuestionOf(["Robin Vale", "Robin Hart"])).toBe(
    "Is this Robin Vale or Robin Hart?"
  );
  expect(personQuestionOf(["the plumber fixing the sink"])).toBe(
    "Is this the plumber fixing the sink?"
  );
});

test("a guess says why in one sentence; a card names itself", () => {
  expect(
    guessAskOf({ confidence: 0.7, name: "Kit Moreau", relation: "the plumber" })
  ).toEqual({
    context: "Life read their messages as Kit Moreau, the plumber (70% sure).",
    question: "Is this Kit?",
  });
  expect(
    cardAskOf(
      "Lou",
      ["+33600000001"],
      [{ name: "Gran" }, { name: "Robin Vale" }]
    )
  ).toEqual({
    contactsCard: { handles: ["+33600000001"], name: "Lou" },
    context: "It is the Contacts card Lou.",
    question: "Is this Gran or Robin?",
  });
});
