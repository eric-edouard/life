import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { AGENT_WORD } from "../core/names";
import { LIFE_STATE_DIR } from "../core/paths";
import { APP_DATA, HOME, MACHINE_DIR, WINDOWS } from "../core/platform";
import { expand } from "../core/settings";
import { Unit } from "../records/unit";
import { ARCHIVE, archiveDb } from "../sources/archived";
import type { Descriptor } from "../sources/contract";
import { DB } from "../sources/imessage";
import { NOTES } from "../sources/notes";
import { PHONE } from "../sources/phone";
import { WHATSAPP } from "../sources/whatsapp";
import { chatDays } from "./closeness";
import {
  enabledSources,
  readySources,
  SOURCES,
  sourceOf,
  tablesOf,
} from "./sources";

test("every stored source name has one descriptor, in the cut order", () => {
  const names = SOURCES.map((s) => s.name);
  expect(names.toSorted()).toEqual(Unit.shape.source.options.toSorted());
  // Of two units with the same content the first cut stays: moving a source changes which.
  expect(names).toEqual([
    "lifelog",
    "imessage",
    "whatsapp",
    "phone",
    "line",
    "instagram",
    "telegram",
    "linkedin",
    "mail",
    "notes",
    "claude",
    "chatgpt",
    "told",
    AGENT_WORD,
    "git",
    "screen",
    "apple-health",
    "photos",
  ]);
});

test("a new source is one descriptor: every table picks it up", () => {
  const radio = {
    chatDays: 3,
    kind: "chat",
    name: "radio",
    read: () => [],
  } as unknown as Descriptor;
  const t = tablesOf([...SOURCES, radio]);
  expect(Object.keys(t.CHATS)).toEqual([
    "imessage",
    "whatsapp",
    "phone",
    "line",
    "instagram",
    "telegram",
    "linkedin",
    "told",
    "radio",
  ]);
  expect(Object.keys(t.SEARCHED)).toContain("radio");
  expect(Object.keys(t.WITH_PEOPLE)).toEqual([
    "imessage",
    "whatsapp",
    "phone",
    "line",
    "instagram",
    "telegram",
    "linkedin",
    "mail",
    "told",
    "radio",
  ]);
  expect(Object.keys(t.OWN_WRITING)).toEqual(["notes", "claude", "chatgpt"]);
  // A source with no search window is not searched (git); mail is searched in its own section.
  expect(Object.keys(tablesOf(SOURCES).SEARCHED)).toEqual([
    "imessage",
    "whatsapp",
    "phone",
    "line",
    "instagram",
    "telegram",
    "linkedin",
    "notes",
    "claude",
    "chatgpt",
    "told",
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
    kind: "own_writing",
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
  expect(existsSync(archiveDb("line"))).toBe(false);
  expect(sourceOf("line").missing?.()).toBe("LINE not archived yet");
  expect(sourceOf("mail").missing?.()).not.toBe("Mail not archived yet");
  // A Mac-only app's archived copy is read on any system; one with no copy says it is the Mac's.
  expect(sourceOf("notes").missing?.()).toBe("Notes not archived yet");
  for (const name of ["imessage", "mail"] as const) {
    expect(sourceOf(name).missing?.() === "macOS only").toBe(WINDOWS);
  }
});

test("a test run reads nothing of this computer: every store path is under its own state", () => {
  const paths = [
    HOME,
    APP_DATA,
    MACHINE_DIR,
    ARCHIVE,
    DB,
    NOTES,
    WHATSAPP,
    PHONE,
  ];
  for (const p of [...paths, expand("~/Work")]) {
    expect(p.startsWith(LIFE_STATE_DIR)).toBe(true);
  }
});

test("table readers forward the exclusive storage end", () => {
  const before = new Date("2023-01-02T00:00:00Z");
  let received: Date | undefined;
  const source = {
    kind: "chat",
    name: "imessage",
    read: (_since: Date, end?: Date) => {
      received = end;
      return [];
    },
  } as unknown as Descriptor;
  tablesOf([source]).CHATS.imessage?.(new Date(0), before);
  expect(received).toBe(before);
});
