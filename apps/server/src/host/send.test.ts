import { expect, test } from "bun:test";
import type { Decision } from "../records/decision";
import type { LedgerEntry } from "../records/ledger-entry";
import { isNewerFrom, sendRefusal } from "./send";

const answered: Decision = {
  answer: "yes",
  answeredAt: "2026-10-29T10:05:00.000Z",
  createdAt: "2026-10-29T10:00:00.000Z",
  id: "asks-20261029100000-1",
  loop: "asks",
  note: "",
  options: [
    { draft: "See you at 8!", id: "yes", label: "Send it" },
    { id: "no", label: "Don't answer" },
  ],
  question: "Answer Ana?",
  ref: "whatsapp:66@s.whatsapp.net",
  status: "answered",
};
const tried = (result: LedgerEntry["result"]) =>
  ({ result }) as unknown as LedgerEntry;
const quiet = () => false;

test("his answered option's draft goes, into the chat its ref names", () => {
  expect(sendRefusal(answered, [], quiet)).toBeNull();
  // The loop takes a decision before it acts on it: a taken one still goes.
  expect(sendRefusal({ ...answered, status: "taken" }, [], quiet)).toBeNull();
  // A try that failed may go again.
  expect(
    sendRefusal(answered, [tried("intent"), tried("failed")], quiet)
  ).toBeNull();
});

test("a send is refused when what he approved no longer stands", () => {
  expect(sendRefusal(undefined, [], quiet)).toBe("no such decision");
  expect(sendRefusal({ ...answered, status: "open" }, [], quiet)).toContain(
    "not answered"
  );
  expect(sendRefusal({ ...answered, answer: "no" }, [], quiet)).toContain(
    "no draft"
  );
  // The ask's own draft is never sent: only the option he chose carries the text he approved.
  expect(
    sendRefusal(
      { ...answered, draft: "Hi", options: [{ id: "yes", label: "Send" }] },
      [],
      quiet
    )
  ).toContain("no draft");
  expect(
    sendRefusal({ ...answered, note: "say 9 instead" }, [], quiet)
  ).toContain("note");
  expect(sendRefusal({ ...answered, ref: "plumber" }, [], quiet)).toContain(
    "not <source>:<chat>"
  );
  expect(sendRefusal({ ...answered, ref: "notes:abc" }, [], quiet)).toContain(
    "not <source>:<chat>"
  );
  expect(sendRefusal(answered, [], () => true)).toContain("came since");
});

test("a send goes once: never again after it went, nor after a try that never ended", () => {
  expect(sendRefusal(answered, [tried("intent"), tried("ok")], quiet)).toBe(
    "already sent"
  );
  expect(sendRefusal(answered, [tried("intent")], quiet)).toContain(
    "never ended"
  );
});

test("only someone else's message in that chat counts as newer", () => {
  const e = (chat: string, fromMe: boolean) =>
    ({ chat, fromMe }) as unknown as Parameters<typeof isNewerFrom>[0][number];
  expect(
    isNewerFrom(
      [e("66@s.whatsapp.net", true), e("44@s.whatsapp.net", false)],
      "66@s.whatsapp.net"
    )
  ).toBe(false);
  expect(
    isNewerFrom([e("66@s.whatsapp.net", false)], "66@s.whatsapp.net")
  ).toBe(true);
});
