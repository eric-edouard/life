import { expect, test } from "bun:test";
import { chatDays } from "../memory/closeness";
import { tablesOf } from "../memory/units";
import { Unit } from "../schema";
import { type Descriptor, SOURCES } from ".";

test("every stored source name has one descriptor, in the cut order", () => {
  const names = SOURCES.map((s) => s.name);
  expect(names.toSorted()).toEqual(Unit.shape.source.options.toSorted());
  // Of two units with the same content the first cut stays: moving a source changes which.
  expect(names).toEqual([
    "lifelog",
    "imessage",
    "whatsapp",
    "beeper",
    "mail",
    "notes",
    "git",
  ]);
});

test("a new source is one descriptor: every table picks it up", () => {
  const radio = {
    chatDays: 3,
    kind: "chat",
    name: "radio",
    read: () => [],
    searchDays: 30,
  } as unknown as Descriptor;
  const t = tablesOf([...SOURCES, radio]);
  expect(Object.keys(t.CHATS)).toEqual([
    "imessage",
    "whatsapp",
    "beeper",
    "radio",
  ]);
  expect(Object.keys(t.SEARCHED)).toContain("radio");
  expect(Object.keys(t.WITH_PEOPLE)).toEqual([
    "imessage",
    "whatsapp",
    "beeper",
    "mail",
    "radio",
  ]);
  // A source with no search window is not searched (git); mail is searched in its own section.
  expect(Object.keys(tablesOf(SOURCES).SEARCHED)).toEqual([
    "imessage",
    "whatsapp",
    "beeper",
    "notes",
  ]);
  expect(Object.keys(tablesOf(SOURCES).SEARCHED_MAIL)).toEqual(["mail"]);
});

test("a chat app's ids say which chats are groups: the closeness counts leave them out", () => {
  const ann = "+15550000001";
  const event = (
    source: "imessage" | "whatsapp",
    chat: string,
    at: string
  ) => ({
    at,
    chat,
    fromMe: false,
    id: `${source}:${chat}:${at}`,
    sender: ann,
    source,
    text: "hi",
  });
  const days = chatDays(
    [
      event("imessage", "chat123", "2026-10-01T10:00:00.000Z"),
      event("whatsapp", "120@g.us", "2026-10-02T10:00:00.000Z"),
      event("imessage", ann, "2026-10-03T10:00:00.000Z"),
    ],
    (s) => (s === ann ? "person:ann" : null)
  );
  expect([...(days.get("person:ann")?.keys() ?? [])]).toEqual(["2026-10-03"]);
});
