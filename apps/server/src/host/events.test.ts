import { expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { HOUR } from "../core/clock";
import {
  answerDecision,
  DECISIONS,
  requestDecision,
} from "../memory/decisions";
import { readPeople } from "../memory/who";
import type { SourceEvent } from "../records/source";
import {
  callMatchableOf,
  DECISION_ANSWERED,
  DECISION_LAPSED,
  MESSAGE_RECEIVED,
  type Messaging,
  matcherOf,
  pollEvents,
  pollMessagesReceived,
  readEndedCalls,
} from "./events";

/** A source whose store holds `list`, row by row from 1, as `incoming` and `read` see it. */
function fake(name: "mail" | "telegram" | "whatsapp", list: SourceEvent[]) {
  return {
    incoming: (from: number) => ({
      end: list.length + 1,
      rows: list
        .map((e, i) => ({ at: e.at, id: e.id, row: i + 1 }))
        .filter((r) => r.row >= from),
    }),
    kind: name === "mail" ? "mail" : "chat",
    label: name,
    name,
    read: (since: Date) => list.filter((e) => e.at >= since.toISOString()),
    silentAfter: 0,
  } as Messaging;
}

let n = 0;
function message(
  source: SourceEvent["source"],
  over: Partial<SourceEvent> = {}
): SourceEvent {
  n += 1;
  return {
    at: new Date(Date.UTC(2026, 10, 8, 9, n)).toISOString(),
    chat: "Test Ana",
    fromMe: false,
    id: `${source}:m${n}`,
    sender: "Test Ana",
    source,
    text: "hello",
    ...over,
  };
}

/** Three stores and the cursor a first poll gives: now, before anything below is written. */
async function stores() {
  const lists = { mail: [], telegram: [], whatsapp: [] } as Record<
    "mail" | "telegram" | "whatsapp",
    SourceEvent[]
  >;
  lists.whatsapp.push(message("whatsapp", { text: "old news" }));
  const sources = (["mail", "telegram", "whatsapp"] as const).map((s) =>
    fake(s, lists[s])
  );
  const first = await pollMessagesReceived(
    { arguments: {}, cursor: null, name: MESSAGE_RECEIVED },
    sources
  );
  return { cursor: first.cursor, first, lists, sources };
}

const at = (
  args: Record<string, unknown>,
  cursor: string,
  sources: Messaging[],
  maxEvents?: number
) =>
  pollMessagesReceived(
    {
      arguments: args,
      cursor,
      name: MESSAGE_RECEIVED,
      ...(maxEvents ? { maxEvents } : {}),
    },
    sources
  );

test("a first poll starts at now: nothing written before it comes", async () => {
  const { first } = await stores();
  expect(first.events).toEqual([]);
  expect(first.hasMore).toBe(false);
});

test("one person on mail, WhatsApp and Telegram, by name; someone else and his own messages left out", async () => {
  const { cursor, lists, sources } = await stores();
  lists.mail.push(message("mail", { chat: "thread-1", sender: "Test Ana" }));
  lists.whatsapp.push(message("whatsapp"));
  lists.telegram.push(message("telegram"));
  lists.telegram.push(
    message("telegram", { chat: "Stranger", sender: "Stranger" })
  );
  lists.whatsapp.push(message("whatsapp", { fromMe: true, sender: "me" }));
  const page = await at({ person: "Test Ana" }, cursor, sources);
  expect(page.events.map((e) => [e.data.source, e.data.person])).toEqual([
    ["mail", "person:test-ana"],
    ["telegram", "person:test-ana"],
    ["whatsapp", "person:test-ana"],
  ]);
  // No text in an event: the agent reads it by its id.
  expect(Object.keys(page.events[0]?.data ?? {})).not.toContain("text");
});

test("his own messages: `from_me`, the person the other side of the 1:1 chat", async () => {
  const { cursor, lists, sources } = await stores();
  lists.whatsapp.push(message("whatsapp", { fromMe: true, sender: "me" }));
  lists.whatsapp.push(message("whatsapp"));
  const page = await at({ from_me: true, person: "Test Ana" }, cursor, sources);
  expect(page.events.map((e) => e.data.id)).toEqual(
    lists.whatsapp.slice(1, 2).map((m) => m.id)
  );
});

test("`text_matches` is a regular expression, any case", async () => {
  const { cursor, lists, sources } = await stores();
  lists.whatsapp.push(message("whatsapp", { text: "the Invoice is attached" }));
  lists.whatsapp.push(message("whatsapp", { text: "lunch?" }));
  const page = await at({ text_matches: "invoice|contract" }, cursor, sources);
  expect(page.events.map((e) => e.data.id)).toEqual(
    lists.whatsapp.slice(1, 2).map((m) => m.id)
  );
});

test("a cursor resumes page by page: nothing skipped, nothing twice, and what came meanwhile next", async () => {
  const { cursor, lists, sources } = await stores();
  lists.mail.push(message("mail"), message("mail"));
  lists.whatsapp.push(message("whatsapp"));
  const seen: (string | undefined)[] = [];
  /** One page of one event from `c`: what it saw, and whether more waits. */
  const next = async (c: string, more: boolean) => {
    const page = await at({}, c, sources, 1);
    seen.push(...page.events.map((e) => e.eventId));
    expect(page.hasMore).toBe(more);
    return page.cursor;
  };
  const last = await next(await next(await next(cursor, true), true), false);
  lists.mail.push(message("mail"));
  seen.push(...(await at({}, last, sources)).events.map((e) => e.eventId));
  expect(seen).toEqual([
    lists.mail[0]?.id,
    lists.mail[1]?.id,
    lists.whatsapp[1]?.id,
    lists.mail[2]?.id,
  ]);
});

test("a store renumbered (Mail rebuilt its index) starts again at its end and says so", async () => {
  const { cursor, lists, sources } = await stores();
  lists.mail.push(message("mail"), message("mail"));
  const past = (await at({}, cursor, sources)).cursor;
  lists.mail.length = 0;
  const page = await at({}, past, sources);
  expect(page.truncated).toBe(true);
  lists.mail.push(message("mail"));
  expect((await at({}, page.cursor, sources)).events).toHaveLength(1);
});

test("an app not on, an unknown person or an unknown event is refused", async () => {
  const { cursor, sources } = await stores();
  await expect(
    at({ channels: ["imessage"] }, cursor, sources)
  ).rejects.toThrow();
  await expect(at({ person: "Nobody Known" }, cursor, sources)).rejects.toThrow(
    "No one goes by"
  );
  await expect(
    pollMessagesReceived(
      { arguments: {}, cursor, name: "ask.received" },
      sources
    )
  ).rejects.toMatchObject({ code: -32_023 });
});

test("his own message in a group: no person, however many others wrote in the same poll", async () => {
  const { cursor, lists, sources } = await stores();
  const group = { chat: "!room:team", chatName: "Team" };
  lists.telegram.push(
    message("telegram", { ...group, fromMe: true, sender: "me" })
  );
  lists.telegram.push(message("telegram", group));
  const page = await at({ from_me: true }, cursor, sources);
  expect(page.events.map((e) => e.data.person)).toEqual([null]);
});

test("a bad or overlong `text_matches` is the client's error", async () => {
  const { cursor, sources } = await stores();
  await Promise.all(
    ["(", "a".repeat(201)].map((pattern) =>
      expect(
        at({ text_matches: pattern }, cursor, sources)
      ).rejects.toMatchObject({ code: -32_602 })
    )
  );
});

test("a source that fails keeps its place; its messages come once it reads again", async () => {
  const { cursor, lists, sources } = await stores();
  lists.whatsapp.push(message("whatsapp"));
  const failing = sources.map((s) =>
    s.name === "whatsapp"
      ? {
          ...s,
          incoming: () => {
            throw new Error("store locked");
          },
        }
      : s
  );
  const page = await at({}, cursor, failing);
  expect(page.events).toEqual([]);
  expect(
    (await at({}, page.cursor, sources)).events.map((e) => e.eventId)
  ).toEqual([lists.whatsapp[1]?.id ?? ""]);
});

test("a poll reads at most 500 rows of a source: a backfill pages through", async () => {
  const { cursor, lists, sources } = await stores();
  for (let i = 0; i < 501; i += 1) {
    lists.whatsapp.push(message("whatsapp"));
  }
  const first = await at({}, cursor, sources, 500);
  expect([first.events.length, first.hasMore]).toEqual([500, true]);
  const second = await at({}, first.cursor, sources, 500);
  expect([second.events.length, second.hasMore]).toEqual([1, false]);
});

test("a source missing from a poll keeps its place: what it wrote meanwhile comes once it is back", async () => {
  const { cursor, lists, sources } = await stores();
  lists.whatsapp.push(message("whatsapp"));
  const without = await at(
    {},
    cursor,
    sources.filter((s) => s.name !== "whatsapp")
  );
  expect(
    (await at({}, without.cursor, sources)).events.map((e) => e.eventId)
  ).toEqual([lists.whatsapp[1]?.id ?? ""]);
});

test("a decision that lapsed wakes its own asker once, with what it said it takes on silence; another agent or a plain app gets nothing", async () => {
  rmSync(DECISIONS, { force: true });
  const start = new Date("2026-11-18T09:00:00.000Z");
  setSystemTime(start);
  try {
    const { id } = await requestDecision("planner", {
      deadline: new Date(start.getTime() + HOUR).toISOString(),
      onSilence: "wait",
      options: [
        { id: "yes", label: "Book Kit" },
        { id: "wait", label: "Wait" },
      ],
      question: "Book Kit?",
      title: "Cheapest.",
    });
    const poll = (agent: string | undefined, cursor: string | null) =>
      pollEvents({ arguments: {}, cursor, name: DECISION_LAPSED }, agent);
    const first = await poll("planner", null);
    expect(first.events).toEqual([]);
    setSystemTime(new Date(start.getTime() + 2 * HOUR));
    const lapsed = await poll("planner", first.cursor);
    expect(lapsed.events).toMatchObject([
      { data: { id, onSilence: "wait" }, name: DECISION_LAPSED },
    ]);
    expect((await poll("planner", lapsed.cursor)).events).toEqual([]);
    expect((await poll("atlas", first.cursor)).events).toEqual([]);
    await expect(poll(undefined, first.cursor)).rejects.toThrow("paired agent");
  } finally {
    setSystemTime();
    rmSync(DECISIONS, { force: true });
  }
});

test("his answer that sends a card's draft wakes its asker with the send's outcome", async () => {
  rmSync(DECISIONS, { force: true });
  const start = new Date("2026-11-18T09:00:00.000Z");
  setSystemTime(start);
  try {
    const { id } = await requestDecision(
      "planner",
      {
        deadline: new Date(start.getTime() + 2 * HOUR).toISOString(),
        draft: { channel: "whatsapp", text: "Friday works", to: "Kit" },
        onSilence: null,
        options: [
          { id: "send", label: "Send it", outgoing: true },
          { id: "no", label: "Don't" },
        ],
        question: "Send Kit this?",
        title: "Confirm Friday",
      },
      start,
      () =>
        Promise.resolve({
          channel: "whatsapp",
          chat: "155@s.whatsapp.net",
          text: "Friday works",
          to: "Kit",
        })
    );
    const first = await pollEvents(
      { arguments: {}, cursor: null, name: DECISION_ANSWERED },
      "planner"
    );
    await answerDecision(id, ["send"], undefined, {
      deliver: () => Promise.resolve("$event1"),
      via: "connector",
    });
    setSystemTime(new Date(start.getTime() + 1000));
    const answered = await pollEvents(
      { arguments: {}, cursor: first.cursor, name: DECISION_ANSWERED },
      "planner"
    );
    expect(answered.events).toMatchObject([
      { data: { id, send: { eventId: "$event1" } } },
    ]);
  } finally {
    setSystemTime();
    rmSync(DECISIONS, { force: true });
  }
});

/** An hour after `e`: the call has ended and is looked at. */
const soon = (e: SourceEvent) => Date.parse(e.at) + HOUR;
const GROUP = { chat: "!room:team", chatName: "Team" };

/** A call of his own in a made-up chat, `seconds` long (null: no end seen). */
const call = (over: Partial<SourceEvent> = {}, seconds: number | null = 600) =>
  message("whatsapp", {
    fromMe: true,
    phoneCall: seconds === null ? { video: true } : { seconds, video: true },
    sender: "me",
    text: "",
    ...over,
  });

test("only a picked-up call that ended is a call: a missed one and one with no end seen are not", async () => {
  const list = [call(), call({}, 0), call({}, null), message("whatsapp")];
  const first = list[0] as SourceEvent;
  const found = readEndedCalls(
    await readPeople(),
    [fake("whatsapp", list)],
    soon(first)
  );
  expect(found.map((c) => c.id)).toEqual([first.id]);
  const [one] = found;
  expect([one?.until, one?.video]).toEqual([
    new Date(Date.parse(first.at) + 600_000).toISOString(),
    true,
  ]);
  // Nothing past the look-back: a call 13 hours old is not looked at.
  expect(
    readEndedCalls(
      await readPeople(),
      [fake("whatsapp", list)],
      soon(first) + 12 * HOUR
    )
  ).toEqual([]);
});

test("a call matches by chat, app and person against who was on it, whoever placed it; his own or text filters match no call", async () => {
  const people = await readPeople();
  const placed = call();
  const joined = call(GROUP);
  const list = [
    message("whatsapp", { ...GROUP, sender: "Test Ana" }),
    placed,
    joined,
  ];
  const [one, group] = readEndedCalls(
    people,
    [fake("whatsapp", list)],
    soon(joined)
  );
  if (!(one && group)) {
    throw new Error("two calls expected");
  }
  const match = (f: Parameters<typeof matcherOf>[0], c = one) =>
    matcherOf(f, people)?.(callMatchableOf(c));
  // His own call to Ana, by the chat (a `from_me: false` filter, as an agent's wait has) and by the person.
  expect(match({ chat: "Test Ana", from_me: false })).toBe(true);
  expect(match({ from_me: false, person: "Test Ana" })).toBe(true);
  // A group call he placed, with Ana in the group: by chat, and by the person who was on it.
  expect(match({ chat: GROUP.chat, from_me: false }, group)).toBe(true);
  expect(match({ from_me: false, person: "Test Ana" }, group)).toBe(true);
  expect(match({ chat: GROUP.chat, from_me: false })).toBe(false);
  expect(match({ channels: ["telegram"], from_me: false })).toBe(false);
  // His own messages and their words are not a call.
  expect(match({ chat: "Test Ana", from_me: true })).toBe(false);
  expect(
    matcherOf(
      { chat: "Test Ana", from_me: false, text_matches: "hi" },
      people
    )?.(callMatchableOf(one))
  ).toBe(false);
  expect(
    matcherOf({ from_me: false, person: "Nobody Madeup" }, people)
  ).toBeNull();
  // Facts only: no text of a message rides on a call.
  expect(Object.keys(one).sort()).toEqual([
    "at",
    "chat",
    "id",
    "people",
    "person",
    "source",
    "until",
    "video",
  ]);
});
