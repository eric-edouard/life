import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceEvent } from "../records/source";
import type { Descriptor } from "../sources/contract";
import { BRIDGES } from "../sources/matrix";
import { readDraftChat } from "./draft-send";

const KIT_JID = /^\d+@s\.whatsapp\.net$/;
const NOW = new Date("2026-11-18T09:00:00.000Z");
const line = (chat: string, chatName: string): SourceEvent => ({
  at: "2026-11-10T12:00:00.000Z",
  chat,
  chatName,
  fromMe: false,
  id: `${chat}:1`,
  sender: chatName,
  source: "telegram",
  text: "hi",
});

/** A made-up bridged source: Ana's two chats, one of them its bridge's room, and a group. */
const source = (
  name: string,
  events: SourceEvent[],
  opens = false
): Descriptor => ({
  kind: "chat",
  label: name,
  name: name as never,
  read: () => events,
  send: {
    block: async () =>
      name === "elsewhere" ? "elsewhere's bridge isn't on this Mac" : undefined,
    holds: (chats) => chats.filter((c) => c.startsWith("!")),
    opens: opens
      ? async (chat) => (KIT_JID.test(chat) ? "Test Kit" : undefined)
      : undefined,
    send: async () => "$ev",
  },
  silentAfter: 0,
});

// Its bridge, added and linked: the made-up provisioning API says its one login is connected.
const provisioning = Bun.serve({
  fetch: () =>
    Response.json({ logins: [{ state: { state_event: "CONNECTED" } }] }),
  port: 0,
});
beforeAll(() => {
  mkdirSync(join(BRIDGES, "sendnet"), { recursive: true });
  writeFileSync(
    join(BRIDGES, "sendnet", "config.yaml"),
    `appservice:\n  port: ${provisioning.port}\nprovisioning:\n  shared_secret: s3cret\n`
  );
});
afterAll(() => {
  provisioning.stop();
  rmSync(join(BRIDGES, "sendnet"), { force: true, recursive: true });
});

test("a draft names one chat its bridge holds: a chat key, or a person with one such 1:1 chat; its name is what his card shows", async () => {
  const sendnet = source("sendnet", [
    line("!ana:life.local", "Test Ana"),
    line("ana-export-id", "Test Ana"),
    line("!crew:life.local", "Boat crew"),
  ]);
  const read = (to: string) =>
    readDraftChat({ channel: "sendnet", to }, NOW, [sendnet]);
  expect(await read("!crew:life.local")).toMatchObject({
    chat: "!crew:life.local",
    name: "Boat crew",
  });
  expect(await read("Test Ana")).toMatchObject({ chat: "!ana:life.local" });
  await expect(read("ana-export-id")).rejects.toThrow("no chat");
  await expect(read("Nobody Known")).rejects.toThrow("no chat");
});

test("a draft is refused when asked: two chats for one person, a source that doesn't send, or a bridge not on this Mac", async () => {
  const two = source("sendnet", [
    line("!ana:life.local", "Test Ana"),
    line("!ana2:life.local", "Test Ana"),
  ]);
  await expect(
    readDraftChat({ channel: "sendnet", to: "Test Ana" }, NOW, [two])
  ).rejects.toThrow("Test Ana has 2 chats on sendnet");
  const mail = { ...two, kind: "mail", name: "mail", send: undefined };
  await expect(
    readDraftChat({ channel: "mail", to: "Test Ana" }, NOW, [
      mail as Descriptor,
      two,
    ])
  ).rejects.toThrow("one of sendnet");
  await expect(
    readDraftChat({ channel: "elsewhere", to: "Test Ana" }, NOW, [
      source("elsewhere", []),
    ])
  ).rejects.toThrow("elsewhere's bridge isn't on this Mac");
});

test("a chat that doesn't exist yet opens by its id when the source can open it; a group it never saw, or a name, doesn't", async () => {
  const wa = source("whatsapp", [line("!ana:life.local", "Test Ana")], true);
  const read = (to: string) =>
    readDraftChat({ channel: "whatsapp", to }, NOW, [wa]);
  expect(await read("66123456@s.whatsapp.net")).toEqual({
    chat: "66123456@s.whatsapp.net",
    name: "Test Kit",
    source: "whatsapp",
  });
  await expect(read("120@g.us")).rejects.toThrow(
    "a group it never saw can't be opened"
  );
  await expect(read("Nobody Known")).rejects.toThrow("no chat");
});
