import { expect, test } from "bun:test";
import { type CheckInputs, checksOf } from "./checks";
import { decision, inputs } from "./checks-test-inputs";

test("a registered agent's card opens its holder's session, never the link it was asked with; another ask opens its first link", () => {
  const asked = {
    ...decision("dec_00000000000a", "2026-11-20T09:00:00.000Z"),
    agent: "agt_0123456789ab",
    links: ["https://agents.example.test/s/asker-old"],
  };
  const sessionOf = (decisions: CheckInputs["decisions"]) =>
    checksOf(inputs([], { decisions })).map((c) => c.session);
  // Its holder has no session: none.
  expect(sessionOf([asked])).toEqual([undefined]);
  expect(
    sessionOf([{ ...asked, session: "https://agents.example.test/s/holder" }])
  ).toEqual(["https://agents.example.test/s/holder"]);
  // Not a registered agent's (his own app's, a paired agent's): its first link.
  const { agent: _, ...own } = asked;
  expect(sessionOf([own])).toEqual(["https://agents.example.test/s/asker-old"]);
});
