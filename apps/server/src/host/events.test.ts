import { expect, test } from "bun:test";
import type { SourceEvent } from "../records/source";
import { MESSAGE_RECEIVED, type Messaging, pollEvents } from "./events";

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
  const first = await pollEvents(
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
  pollEvents(
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
    pollEvents({ arguments: {}, cursor, name: "ask.received" }, sources)
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
