import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { SourceEvent } from "../records/source";
import {
  communicationStyleBlock,
  communicationStyles,
  communicationStylesOf,
  communicationStyleTargetsOf,
  inputOf,
  readCommunicationStyle,
  sentDraftsOf,
  styleLines,
  styleSampleOf,
} from "./communication-styles";
import type { Decision } from "./decision-lines";
import { communicationStylePath } from "./memory-files";
import { lifeChat } from "./units";

const msg = (
  i: number,
  fromMe: boolean,
  extra: Partial<SourceEvent> = {}
): SourceEvent => ({
  at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  chat: "+1",
  fromMe,
  id: `m:${i}`,
  sender: fromMe ? "me" : "+1",
  source: "whatsapp",
  text: `m${i}`,
  ...extra,
});

test("a sample is the newest 120 chat messages and 30 mails, both ways, oldest first", () => {
  const events = [
    ...Array.from({ length: 130 }, (_, i) => msg(i, i % 2 === 0)),
    ...Array.from({ length: 40 }, (_, i) =>
      msg(i, true, { id: `mail:${i}`, source: "mail", text: `mail${i}` })
    ),
  ].toReversed();
  const { chat, mail } = styleSampleOf(events);
  expect(chat.map((m) => m.text)).toEqual(
    Array.from({ length: 120 }, (_, i) => `m${i + 10}`)
  );
  expect(chat.some((m) => m.fromMe) && chat.some((m) => !m.fromMe)).toBe(true);
  expect(mail).toHaveLength(30);
  expect(mail[0]?.text).toBe("mail10");
});

test("Life's output, the agent's reports, calls and bulk mail are never writing a style learns from", () => {
  const { chat, mail } = styleSampleOf([
    msg(1, true, { text: "kept" }),
    msg(2, true, { chat: lifeChat(), text: "life brief" }),
    msg(3, true, { source: "agent", text: "agent report" }),
    msg(4, false, { phoneCall: { seconds: 30, video: false }, text: "" }),
    msg(5, false, { bulk: true, source: "mail", text: "newsletter" }),
  ]);
  expect(chat.map((m) => m.text)).toEqual(["kept"]);
  expect(mail).toEqual([]);
});

test("a draft Life sent for him is his message but never a sample: the same words in another chat are kept", () => {
  const sent = sentDraftsOf([
    {
      draft: {
        channel: "whatsapp",
        chat: "+1",
        text: "See you at 8 ",
        to: "Ana",
      },
      send: { eventId: "$e" },
    } as unknown as Decision,
  ]);
  const { chat } = styleSampleOf(
    [
      msg(1, true, { text: "See you at 8" }),
      msg(2, true, { chat: "+2", text: "See you at 8" }),
      msg(3, false, { text: "See you at 8" }),
    ],
    sent
  );
  expect(chat.map((m) => m.fromMe)).toEqual([true, false]);
});

test("only paged people with a 1:1 chat or mail are read", () => {
  const direct = new Map([
    ["person:ana", [msg(1, true)]],
    ["person:bob", [msg(2, true, { source: "agent" })]],
  ]);
  const targets = communicationStyleTargetsOf(
    new Set(["person:ana", "person:bob", "person:cy", "person:me"]),
    direct
  );
  expect(targets.map((t) => t.ref)).toEqual(["person:ana"]);
});

test("a quote stays only as that writer's own chat words; a source not shown or a bad line goes", () => {
  const sample = styleSampleOf([
    msg(1, true, { text: "Ok ça marche, à demain !! 😘" }),
    msg(2, false, { text: "Bonjour, bien reçu." }),
    msg(3, true, { source: "mail", text: "Bien à vous, Zoe" }),
  ]);
  const reply = {
    lines: [
      {
        kind: "chat",
        quotes: ["ok ca marche", "Bonjour, bien reçu.", "Bien à vous"],
        source: "whatsapp",
        text: "Short, warm.",
        writer: "owner",
      },
      { kind: "chat", quotes: [], source: "line", text: "x", writer: "them" },
      { kind: "fax", quotes: [], text: "Not a kind.", writer: "them" },
      { kind: null, quotes: [], text: "Formal.", writer: "robot" },
    ],
  };
  const lines = styleLines(reply, sample);
  expect(lines).toEqual([
    {
      kind: "chat",
      quotes: [{ at: sample.chat[0]?.at ?? "", text: "Ok ça marche" }],
      source: "whatsapp",
      text: "Short, warm.",
      writer: "owner",
    },
    { kind: "chat", quotes: [], text: "x", writer: "them" },
  ]);
  expect(styleLines("not json", sample)).toEqual([]);
});

test("the call is shown who wrote each message", () => {
  const sample = styleSampleOf([msg(1, true), msg(2, false)]);
  expect(inputOf("Ana", sample).chat.map((m) => m.who)).toEqual([
    "him",
    "them",
  ]);
});

test("a file of the 6 Nov shape reads as none; one of this shape is read and shown in `now`", async () => {
  const ref = "person:style-shape";
  const path = communicationStylePath(ref);
  try {
    await Bun.write(
      path,
      JSON.stringify({
        built: "2026-11-06T00:00:00.000Z",
        inputs: "a",
        lines: [{ examples: [], kind: null, text: "Old." }],
        madeBy: {},
        page: ref,
        schemaVersion: 1,
      })
    );
    expect(readCommunicationStyle(ref)).toEqual([]);
    await Bun.write(
      path,
      JSON.stringify({
        built: "2026-11-06T00:00:00.000Z",
        inputs: "a",
        lines: [
          {
            kind: "chat",
            quotes: [{ at: "2026-10-01T00:00:00.000Z", text: "haha ok" }],
            source: "whatsapp",
            text: "Short.",
            writer: "them",
          },
        ],
        madeBy: { engine: "claude", model: "m", prompt: "p", run: "r" },
        page: ref,
        schemaVersion: 2,
      })
    );
    const block = communicationStyleBlock(readCommunicationStyle(ref));
    expect(block).toContain('- they, chat (whatsapp): Short. E.g. "haha ok"');
    expect(communicationStyleBlock([])).toEqual([]);
  } finally {
    rmSync(path, { force: true });
  }
});

test("a person who lost their page keeps their file: a night never removes one", async () => {
  const ref = "person:lost-page";
  const path = communicationStylePath(ref);
  try {
    await Bun.write(path, "{}\n");
    await communicationStyles({ events: [], failed: [], since: new Date(0) });
    expect(await Bun.file(path).exists()).toBe(true);
  } finally {
    rmSync(path, { force: true });
  }
});

test("a draft's styles: each person's block under their name, none for one with no style", async () => {
  const ref = "person:style-of";
  const path = communicationStylePath(ref);
  try {
    await Bun.write(
      path,
      JSON.stringify({
        built: "2026-11-06T00:00:00.000Z",
        inputs: "a",
        lines: [
          {
            kind: "chat",
            quotes: [{ at: "2026-10-01T00:00:00.000Z", text: "ok cool" }],
            source: "whatsapp",
            text: "Lowercase, no emoji.",
            writer: "owner",
          },
        ],
        madeBy: { engine: "claude", model: "m", prompt: "p", run: "r" },
        page: ref,
        schemaVersion: 2,
      })
    );
    const lines = communicationStylesOf([ref, "person:no-style"], (r) =>
      r === ref ? "Test Bo" : "Test Cy"
    );
    expect(lines[0]).toBe("With Test Bo:");
    expect(lines.join("\n")).toContain(
      '- you, chat (whatsapp): Lowercase, no emoji. E.g. "ok cool"'
    );
    expect(lines.join("\n")).not.toContain("Test Cy");
    expect(communicationStylesOf([], () => "")).toEqual([]);
  } finally {
    rmSync(path, { force: true });
  }
});
