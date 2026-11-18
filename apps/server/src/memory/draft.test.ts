import { expect, test } from "bun:test";
import { draftProblemOf, draftWords, type MessageDraft } from "./draft";

const chat = (over: Partial<MessageDraft> = {}): MessageDraft => ({
  text: "Hi @Ana and @Bo",
  to: "Test Ana",
  ...over,
});

test("a chat draft holds text, a file or a reaction; a reaction is an emoji on a message and nothing else", () => {
  expect(draftProblemOf(chat(), "chat")).toBeUndefined();
  expect(draftProblemOf({ to: "Test Ana" }, "chat")).toContain("needs `text`");
  expect(draftProblemOf({ file: "/a.pdf", to: "x" }, "chat")).toBeUndefined();
  const react = { onMessage: "m1", reaction: "👍", to: "x" };
  expect(draftProblemOf(react, "chat")).toBeUndefined();
  for (const more of [
    { text: "no" },
    { file: "/a" },
    { onMessage: undefined },
  ]) {
    expect(draftProblemOf({ ...react, ...more }, "chat")).toContain(
      "emoji on `onMessage` and nothing else"
    );
  }
  expect(
    draftProblemOf({ ...react, mentions: [{ name: "A", sender: "s" }] }, "chat")
  ).toContain("nothing else");
});

test("each mention is an `@name` of the text, in the text's order", () => {
  const a = { name: "Ana", sender: "a" };
  const bo = { name: "Bo", sender: "b" };
  expect(draftProblemOf(chat({ mentions: [a, bo] }), "chat")).toBeUndefined();
  expect(draftProblemOf(chat({ mentions: [bo, a] }), "chat")).toContain(
    "needs `@Ana`"
  );
  expect(
    draftProblemOf(chat({ mentions: [{ name: "Cy", sender: "c" }] }), "chat")
  ).toContain("needs `@Cy`");
});

test("mail needs a sender and a subject and takes no reaction or mention; a chat takes none of mail's fields", () => {
  const mail = {
    from: "me@example.com",
    subject: "Friday",
    text: "Hi @Ana",
    to: "a@example.com",
  };
  expect(draftProblemOf(mail, "mail")).toBeUndefined();
  expect(
    draftProblemOf({ ...mail, cc: "b@example.com" }, "mail")
  ).toBeUndefined();
  expect(draftProblemOf({ ...mail, from: undefined }, "mail")).toContain(
    "`from` and `subject`"
  );
  expect(draftProblemOf({ ...mail, subject: undefined }, "mail")).toContain(
    "`from` and `subject`"
  );
  expect(
    draftProblemOf(
      { ...mail, mentions: [{ name: "Ana", sender: "s" }] },
      "mail"
    )
  ).toContain("no `reaction` or `mentions`");
  for (const over of [
    { from: "me@example.com" },
    { subject: "x" },
    { cc: "c@example.com" },
  ]) {
    expect(draftProblemOf(chat(over), "chat")).toContain("are for mail");
  }
});

test("the report words a draft in lines: to and text, then its file, the message quoted, mentions and mail's parts", () => {
  expect(
    draftWords({
      chat: "!r",
      file: {
        mime: "application/pdf",
        name: "menu.pdf",
        path: "/a/menu.pdf",
        sha256: "0".repeat(64),
        size: 2_500_000,
      },
      mentions: [{ name: "Ana", sender: "a" }],
      quoted: { sender: "Ana", text: "Friday?" },
      text: "Yes @Ana",
      to: "Boat crew",
    })
  ).toEqual([
    'Draft to Boat crew: "Yes @Ana"',
    "File menu.pdf (2.5 MB)",
    'Reply to Ana: "Friday?"',
    "Mentions Ana",
  ]);
  expect(
    draftWords({
      onMessage: "m",
      quoted: { sender: "Ana", text: "ok" },
      reaction: "👍",
      to: "Ana",
    })
  ).toEqual(["Draft to Ana", 'Reaction 👍 to Ana: "ok"']);
});
