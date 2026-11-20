import { expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceEvent } from "../records/source";
import { buildIndex } from "./index-writer";
import { INDEX, UNITS } from "./memory-files";
import {
  type NetworkIdentified,
  type NetworkIdentity,
  networkIdentityOf,
  readNetworkIdentities,
  withNetworkIdentity,
} from "./network-identity";
import { unit as unitFixture } from "./record-fixtures";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as sources from "./sources";

// Made-up people, phones and chats only.

const KIT_CHAT = "33600000001@s.whatsapp.net";

const message = (over: Partial<SourceEvent>): SourceEvent => ({
  at: "2026-11-02T09:00:00.000Z",
  chat: KIT_CHAT,
  chatName: "Kit Shop",
  fromMe: false,
  id: `whatsapp:${KIT_CHAT}/1`,
  sender: "+33600000001",
  source: "whatsapp",
  text: "Kit here, from the shop",
  ...over,
});

const unit = (over = {}) => ({
  date: "2026-11-02",
  end: "2026-11-02T10:00:00.000Z",
  id: "unit_000000000001",
  key: KIT_CHAT,
  source: "whatsapp" as const,
  start: "2026-11-02T09:00:00.000Z",
  title: "Kit Shop",
  ...over,
});

test("a WhatsApp chat gives its network, phone, shown name, newest message on one line and its wa.me link", () => {
  const events = [
    message({}),
    message({
      at: "2026-11-02T10:00:00.000Z",
      fromMe: true,
      id: `whatsapp:${KIT_CHAT}/2`,
      sender: "me",
      text: "Great,\n\nsee you   Friday",
    }),
  ];
  expect(networkIdentityOf(unit(), events, "Dana")).toEqual({
    chat: KIT_CHAT,
    handle: "+33600000001",
    network: "WhatsApp",
    newest: {
      at: "2026-11-02T10:00:00.000Z",
      by: "Dana",
      text: "Great, see you Friday",
    },
    openUrl: "https://wa.me/33600000001",
    shownName: "Kit Shop",
  });
});

test("Messages opens a 1:1 chat by sms:, and a long message is cut to one line", () => {
  const chat = "+33600000002";
  const long = "word ".repeat(60);
  const identity = networkIdentityOf(
    unit({ key: chat, source: "imessage", title: chat }),
    [
      message({
        chat,
        chatName: undefined,
        id: "imessage:1",
        sender: chat,
        source: "imessage",
        text: long,
      }),
    ],
    "Dana"
  );
  expect(identity).toMatchObject({
    handle: chat,
    network: "iMessage",
    openUrl: "sms:+33600000002",
    // A chat-day titled by its key shows no name.
    shownName: null,
  });
  expect(identity.newest?.by).toBe(chat);
  expect(identity.newest?.text.length).toBeLessThanOrEqual(120);
  expect(identity.newest?.text.endsWith("…")).toBe(true);
});

test("a WhatsApp chat whose key holds no phone takes the sender's, and a @lid alone opens nothing", () => {
  const lid = "123456@lid";
  const byPhone = networkIdentityOf(
    unit({ key: lid }),
    [message({ chat: lid, sender: "+33 6 00 00 00 03" })],
    "Dana"
  );
  expect(byPhone.openUrl).toBe("https://wa.me/33600000003");
  const none = networkIdentityOf(
    unit({ key: lid }),
    [message({ chat: lid, sender: lid })],
    "Dana"
  );
  expect(none.openUrl).toBeNull();
  // Nothing read of the span: no newest, the unit's title still names it.
  expect(networkIdentityOf(unit(), [], "Dana")).toMatchObject({
    newest: null,
    shownName: "Kit Shop",
  });
});

/** Who the identities name: Kit, by his WhatsApp number; Dana is the owner. */
const kitPeople = {
  nameOf: () => "Dana",
  partyOf: (ref: string) => ({ kind: "person" as const, name: "Kit", ref }),
  resolve: (h: string) => (h === "+33600000001" ? "person:inf_kit" : null),
};

test("a decision's guess beside it gets its identity too; a check none was found for gets null", () => {
  const identity = networkIdentityOf(unit(), [message({})], "Dana");
  interface Shown extends NetworkIdentified {
    confirm: Shown[];
    ref: string;
  }
  const guess: Shown = { confirm: [], ref: "person:inf_kit" };
  const decision: Shown = { confirm: [guess], ref: "dec_000000000001" };
  const shown = withNetworkIdentity(
    decision,
    new Map([["person:inf_kit", identity]]),
    kitPeople
  );
  expect(shown.networkIdentity).toBeNull();
  expect(shown.confirm[0]?.networkIdentity).toEqual(identity);
});

test("read from the index, the unit files and one span of the source: a card's handle finds its newest 1:1 chat, not a group", async () => {
  const handle = "+33600000004";
  const chat = "33600000004@s.whatsapp.net";
  const direct = unitFixture({
    date: "2026-11-03",
    end: "2026-11-03T18:00:00.000Z",
    id: "unit_00000000000d",
    key: chat,
    people: [`unknown:${handle}`, "person:me"],
    refs: ["whatsapp:1"],
    source: "whatsapp",
    start: "2026-11-03T17:00:00.000Z",
    title: "Lou B",
  });
  // A newer group day only Lou wrote in: the index can't tell it is a group, its key can.
  const group = unitFixture({
    ...direct,
    date: "2026-11-04",
    end: "2026-11-04T18:00:00.000Z",
    id: "unit_00000000000e",
    key: "120000000000000001@g.us",
    start: "2026-11-04T17:00:00.000Z",
    title: "Climbing",
  });
  const asked: [Date, Date | undefined][] = [];
  const real = sources.sourceOf;
  const spy = spyOn(sources, "sourceOf").mockImplementation(
    (name) =>
      ({
        ...real(name),
        read: (since: Date, before?: Date) => {
          asked.push([since, before]);
          return [
            message({
              at: "2026-11-03T17:30:00.000Z",
              chat,
              chatName: "Lou B",
              sender: handle,
              text: "Sunday works",
            }),
          ];
        },
      }) as never
  );
  mkdirSync(UNITS, { recursive: true });
  mkdirSync(dirname(INDEX), { recursive: true });
  try {
    for (const u of [direct, group]) {
      writeFileSync(join(UNITS, `${u.date}.jsonl`), `${JSON.stringify(u)}\n`);
    }
    buildIndex(
      [],
      INDEX,
      {
        corrections: [],
        live: new Set(),
        retired: new Map(),
        standing: new Map(),
      },
      [{ unit: direct }, { unit: group }]
    );
    const card = {
      about: [handle],
      confirm: [],
      kind: "person",
      ref: "person:con_lou",
    };
    const found = await readNetworkIdentities([card], {
      nameOf: () => "Dana",
      partyOf: (ref: string) => ({ kind: "person", name: "Lou", ref }),
      refOf: (r: string) => r,
      resolve: () => null,
      truth: {
        people: [{ handles: {}, id: "me", name: "Dana" }],
        projects: [],
      },
    } as never);
    expect(found.get("person:con_lou")).toEqual({
      chat,
      handle,
      network: "WhatsApp",
      newest: {
        at: "2026-11-03T17:30:00.000Z",
        by: "Lou B",
        text: "Sunday works",
      },
      openUrl: "https://wa.me/33600000004",
      party: { kind: "person", name: "Lou", ref: "person:con_lou" },
      shownName: "Lou B",
    });
    // One read of the source, over the chat-day's span only.
    expect(asked).toEqual([
      [new Date(direct.start), new Date(Date.parse(direct.end) + 1)],
    ]);
  } finally {
    spy.mockRestore();
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});

test("a decision's draft gets its chat as its network shows it, reading nothing; mail and a draft with no chat get null", () => {
  const draft = {
    channel: "whatsapp",
    chat: "33600000001@s.whatsapp.net",
    to: "Kit Moreau",
  };
  const shown = (d: typeof draft | { channel: string; to: string }) =>
    withNetworkIdentity(
      { confirm: [], draft: d, ref: "dec_1" } as {
        confirm: never[];
        draft: typeof d;
        networkIdentity?: NetworkIdentity | null;
        ref: string;
      },
      new Map(),
      kitPeople
    ).networkIdentity;
  expect(shown(draft)).toMatchObject({
    chat: draft.chat,
    network: "WhatsApp",
    newest: null,
    party: { name: "Kit", ref: "person:inf_kit" },
    shownName: "Kit Moreau",
  });
  // A chat whose handle no one goes by has no party.
  expect(
    shown({ ...draft, chat: "33600000002@s.whatsapp.net" })?.party
  ).toBeUndefined();
  expect(shown({ channel: "gmail", to: "kit@example.com" })).toBeNull();
});
