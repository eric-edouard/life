import { expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceEvent } from "../records/source";
import { buildIndex } from "./index-writer";
import { INDEX, UNITS } from "./memory-files";
import {
  cardAskOf,
  chatUnitsFor,
  guessAskOf,
  type NetworkIdentified,
  networkIdentityOf,
  personQuestionOf,
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
    // Another chat in the same span is not this one's.
    message({
      at: "2026-11-02T11:00:00.000Z",
      chat: "33600000009@s.whatsapp.net",
      text: "not Kit",
    }),
  ];
  expect(networkIdentityOf(unit(), events, "Alex")).toEqual({
    chat: KIT_CHAT,
    handle: "+33600000001",
    network: "WhatsApp",
    newest: {
      at: "2026-11-02T10:00:00.000Z",
      by: "Alex",
      text: "Great, see you Friday",
    },
    openUrl: "https://wa.me/33600000001",
    shownName: "Kit Shop",
  });
});

test("a network without a link of its own gives null, and a long message is cut to one line", () => {
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
    "Alex"
  );
  expect(identity).toMatchObject({
    handle: chat,
    network: "iMessage",
    openUrl: null,
    // A chat-day titled by its key shows no name.
    shownName: null,
  });
  expect(identity.newest?.by).toBe(chat);
  expect(identity.newest?.text).toHaveLength(120);
  expect(identity.newest?.text.endsWith("…")).toBe(true);
});

test("a WhatsApp chat whose key holds no phone takes the sender's, and a @lid alone opens nothing", () => {
  const lid = "123456@lid";
  const byPhone = networkIdentityOf(
    unit({ key: lid }),
    [message({ chat: lid, sender: "+33 6 00 00 00 03" })],
    "Alex"
  );
  expect(byPhone.openUrl).toBe("https://wa.me/33600000003");
  const none = networkIdentityOf(
    unit({ key: lid }),
    [message({ chat: lid, sender: lid })],
    "Alex"
  );
  expect(none.openUrl).toBeNull();
  // Nothing read of the span: no newest, the unit's title still names it.
  expect(networkIdentityOf(unit(), [], "Alex")).toMatchObject({
    newest: null,
    shownName: "Kit Shop",
  });
});

test("the chat-days tried are 1:1 chats with the check's person (or its guess's evidence), newest first, three at most", () => {
  const u = (id: string, date: string, people: string[], source = "whatsapp") =>
    ({ date, id, people, source }) as Parameters<typeof chatUnitsFor>[0][0];
  const units = [
    u("unit_a", "2026-11-01", ["person:me", "person:inf_kit"]),
    u("unit_b", "2026-11-03", ["unknown:+33600000001"]),
    // A group's day: someone else wrote too.
    u("unit_c", "2026-11-04", ["person:inf_kit", "person:zoe"]),
    // Mail is no network's chat.
    u("unit_d", "2026-11-05", ["person:inf_kit"], "mail"),
    u("unit_e", "2026-10-01", ["unknown:+33600000009"]),
    u("unit_f", "2026-09-01", ["person:inf_kit"]),
    u("unit_g", "2026-08-01", ["person:inf_kit"]),
  ];
  const refs = new Set(["person:inf_kit", "unknown:+33600000001"]);
  expect(
    chatUnitsFor(units, refs, new Set(["unit_e"])).map((x) => x.id)
  ).toEqual(["unit_b", "unit_a", "unit_e"]);
});

test("the question names the first name, both of a card's people, or a description whole", () => {
  expect(personQuestionOf(["Kit Moreau"])).toBe("Is this Kit?");
  expect(personQuestionOf(["Gran", "Robin Vale"])).toBe(
    "Is this Gran or Robin?"
  );
  expect(personQuestionOf(["the plumber fixing the sink"])).toBe(
    "Is this the plumber fixing the sink?"
  );
});

test("a decision's guess beside it gets its identity too; a check none was found for gets null", () => {
  const identity = networkIdentityOf(unit(), [message({})], "Alex");
  interface Shown extends NetworkIdentified {
    confirm: Shown[];
    ref: string;
  }
  const guess: Shown = { confirm: [], ref: "person:inf_kit" };
  const decision: Shown = { confirm: [guess], ref: "dec_000000000001" };
  const shown = withNetworkIdentity(
    decision,
    new Map([["person:inf_kit", identity]])
  );
  expect(shown.networkIdentity).toBeNull();
  expect(shown.confirm[0]?.networkIdentity).toEqual(identity);
});

test("a guess says why in one sentence in one sentence; a card names itself", () => {
  expect(
    guessAskOf({ confidence: 0.7, name: "Kit Moreau", relation: "the plumber" })
  ).toEqual({
    context: "Life read their messages as Kit Moreau, the plumber (70% sure).",
    question: "Is this Kit?",
  });
  expect(cardAskOf("Lou", [{ name: "Gran" }, { name: "Robin Vale" }])).toEqual({
    context: "It is the Contacts card Lou.",
    question: "Is this Gran or Robin?",
  });
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
  const spy = spyOn(sources, "tables").mockReturnValue({
    WITH_PEOPLE: {
      whatsapp: (since: Date, before?: Date) => {
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
    },
  } as never);
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
      inferred: [],
      nameOf: () => "Alex",
      refOf: (r) => r,
    });
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
