import { expect, test } from "bun:test";
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
  expect(t.CHAT_DAYS.radio).toBe(3);
  expect(t.SEARCH_DAYS.radio).toBe(30);
  // A source with no search window is not searched; mail is not (yet).
  expect(Object.keys(tablesOf(SOURCES).SEARCHED)).toEqual([
    "imessage",
    "whatsapp",
    "beeper",
    "notes",
  ]);
});
