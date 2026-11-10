import { expect, test } from "bun:test";
import { directOf } from "@life/server/src/memory/closeness";
import { readPeople } from "@life/server/src/memory/who";
import type { SourceEvent } from "@life/server/src/records/source";
import { pairMarkdownOf } from "./pair-counts";

const message = (
  at: string,
  fromMe: boolean,
  deleted = false
): SourceEvent => ({
  at,
  chat: "made-up-direct",
  chatName: "Test Ana",
  deleted,
  fromMe,
  id: at,
  sender: fromMe ? "me" : "made-up-direct",
  source: "whatsapp",
  text: "hello",
});

test("counts use resolved one-to-one messages, with every count explained overall and by local year", async () => {
  const messages = [
    message("2025-12-31T12:00:00.000Z", false),
    message("2025-12-31T12:10:00.000Z", true, true),
    message("2025-12-31T23:30:00.000Z", true),
    message("2025-12-31T23:35:00.000Z", false, true),
    message("2026-01-02T12:00:00.000Z", false),
  ];
  // The fixture's historical zone in 2025 is Lisbon; this instant is 2027 locally in Lagos.
  messages.push(message("2026-12-31T23:30:00.000Z", true));
  const group = {
    ...messages[0],
    chat: "made-up@g.us",
    id: "group",
    text: "not direct",
  } as SourceEvent;
  const [person] = directOf(
    ["Test Ana"],
    [...messages, group],
    await readPeople()
  );
  expect(person?.known).toBe("test-ana");
  expect(person?.messages).toHaveLength(messages.length);
  const markdown = pairMarkdownOf("Test Ana", person?.messages ?? []);
  expect(markdown).toStartWith("# Test Ana\n\n## Overall");
  expect(markdown).toContain("Messages the owner sent: 3.");
  expect(markdown).toContain("Messages the person sent: 3.");
  expect(markdown).toContain("Sent messages the owner deleted: 1.");
  expect(markdown).toContain("Sent messages the person deleted: 1.");
  expect(markdown).toContain(
    "Owner's median minutes to answer within an exchange: 10."
  );
  expect(markdown).toContain(
    "Person's median minutes to answer within an exchange: 5."
  );
  expect(markdown).toContain(
    "Owner wrote first after 6 hours of quiet (including the first exchange): 2."
  );
  expect(markdown).toContain(
    "Person wrote first after 6 hours of quiet (including the first exchange): 2."
  );
  const [, year] = markdown.split("## 2027");
  expect(year).toContain("Messages the owner sent: 1.");
  expect(year).toContain("Messages the person sent: 0.");
  expect(year).toContain("no answers");
  expect(pairMarkdownOf("Nobody", [])).toContain("Days with a message: 0.");
});
