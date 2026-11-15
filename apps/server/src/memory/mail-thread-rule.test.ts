import { expect, test } from "bun:test";
import type { SourceEvent } from "../records/source";
import { applyRules, messageUnits } from "./units";

const mail = (
  chat: string,
  sender: string,
  title: string,
  over: Partial<SourceEvent> = {}
): SourceEvent => ({
  at: "2026-10-09T10:00:00.000Z",
  chat,
  chatName: title,
  fromMe: false,
  id: `${chat}:${sender}`,
  sender,
  source: "mail",
  text: `${title}\nA sentence long enough to be read as a message of its own.`,
  ...over,
});

test("a reply from an unknown address in a thread the owner wrote in on another day is kept; a shop's mail and a list's issue are not", () => {
  const built = applyRules(
    messageUnits(
      [
        mail("t1", "cousin@gmail.test", "Re: Trip", {
          hasOwnerWrittenInThread: true,
        }),
        mail("t2", "sales@shop.test", "Your quote"),
        mail("t3", "list@club.test", "Issue 9", {
          bulk: true,
          hasOwnerWrittenInThread: true,
        }),
      ],
      () => null
    )
  );
  expect(built.map((b) => b.unit.drop ?? null)).toEqual([
    null,
    "not-a-person",
    "newsletter",
  ]);
});
