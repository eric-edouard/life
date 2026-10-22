import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chatDays } from "../memory/closeness";
import { tablesOf } from "../memory/units";
import { AGENT_WORD, Unit } from "../schema";
import {
  type Descriptor,
  enabledSources,
  readySources,
  SOURCES,
  sourceOf,
} from ".";
import { archiveDb } from "./archived";

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
    "claude",
    "chatgpt",
    AGENT_WORD,
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
    "claude",
    "chatgpt",
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

test("only the sources he turned on are read, and one not set up yet is left out, never a failure", () => {
  const ready = {
    kind: "notes",
    label: "Ready",
    name: "notes",
    read: () => [],
    silentAfter: 1,
  } as Descriptor;
  const notYet = {
    ...ready,
    missing: () => "Full Disk Access for Life",
    name: "imessage",
  } as Descriptor;
  const on = enabledSources([ready, notYet], ["notes", "imessage"]);
  expect(readySources(on).map((s) => s.name)).toEqual(["notes"]);
  expect(enabledSources([ready, notYet], ["imessage"])).toEqual([notYet]);
  // A fresh install turns nothing on: nothing is read, and nothing fails.
  expect(enabledSources(SOURCES, [])).toEqual([]);
});

test("an archived source can't be read until the archive copied its store; others keep their own reason", () => {
  expect(existsSync(archiveDb("notes"))).toBe(false);
  expect(sourceOf("notes").missing?.()).toBe("Notes not archived yet");
  expect(sourceOf("mail").missing?.()).not.toBe("Mail not archived yet");
});
