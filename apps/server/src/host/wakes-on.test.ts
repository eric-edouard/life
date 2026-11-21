import { expect, test } from "bun:test";
import { meant, type People, readPeople } from "../memory/who";
import type { EventFilter } from "../records/registered-agent";
import type { SourceEvent } from "../records/source";
import { EVENT_CHANNELS, type Matchable } from "./event-channels";
import {
  callMatchableOf,
  matcherOf,
  messageMatchableOf,
  messagePayloadOf,
} from "./events";
import { type WakesOnContext, wakesOnOf } from "./registered-agents";

// What will wake an agent (`wakesOn`): each line is checked against the real `matcherOf`, over made-up people, chats
// and payments.

const GROUP = "120363000000000001@g.us";
const DM = "33600000001@s.whatsapp.net";
const base = await readPeople();
const people: People = {
  ...base,
  truth: { ...base.truth, chats: [{ id: GROUP, name: "Test Crew" }] },
};
const ana = people.partyOf(`person:${meant("Test Ana", people).known}`);

const filter = (f: Partial<EventFilter>): EventFilter => ({
  from_me: false,
  ...f,
});
const ctx = (over: Partial<WakesOnContext> = {}): WakesOnContext => ({
  cards: [],
  channels: EVENT_CHANNELS,
  hasNet: false,
  people,
  seen: {},
  ...over,
});
const fires = (f: EventFilter, x: Matchable) =>
  matcherOf(f, people)?.(x) ?? false;

let n = 0;
const sourceEvent = (over: Partial<SourceEvent> = {}): SourceEvent => {
  n += 1;
  return {
    at: new Date(Date.UTC(2026, 10, 20, 9, n)).toISOString(),
    chat: "Test Ana",
    fromMe: false,
    id: `whatsapp:w${n}`,
    sender: "Test Ana",
    source: "whatsapp",
    text: "hello",
    ...over,
  };
};
const message = (over: Partial<SourceEvent> = {}) => {
  const e = sourceEvent(over);
  return messageMatchableOf(messagePayloadOf(e, people), e);
};
const call = (over: Partial<SourceEvent> = {}) => {
  const e = sourceEvent(over);
  const m = messagePayloadOf(e, people);
  return callMatchableOf({
    ...m,
    people: m.person ? [m.person] : [],
    until: e.at,
    video: false,
  });
};
const payment = (over: Partial<Matchable> = {}): Matchable => ({
  channel: "payments",
  isNamedOnly: true,
  quantities: { eur_out: 80 },
  text: "Test Bakery",
  ...over,
});

test("a person's line: the party they are now beside the words as written, and it covers their calls", () => {
  const f = filter({ person: "Test Ana" });
  expect(wakesOnOf([f], ctx())).toEqual([
    {
      calls: true,
      kind: "message",
      party: ana,
      personAsWritten: "Test Ana",
    },
  ]);
  expect(fires(f, message())).toBe(true);
  expect(fires(f, call())).toBe(true);
  expect(fires(f, message({ chat: "Test Bo", sender: "Test Bo" }))).toBe(false);
});

test("a person no one goes by now is a line that says it can never fire", () => {
  const f = filter({ person: "Nobody Madeup" });
  expect(matcherOf(f, people)).toBeNull();
  expect(wakesOnOf([f], ctx())).toEqual([
    {
      broken: "unknown_person",
      calls: true,
      kind: "message",
      personAsWritten: "Nobody Madeup",
    },
  ]);
});

test("a chat: its name from his directory with its app and whether it is a group; else from the agent's own newest event there; else none", () => {
  const f = filter({ channels: ["whatsapp"], chat: GROUP });
  expect(wakesOnOf([f], ctx())).toEqual([
    {
      apps: ["whatsapp"],
      calls: true,
      chat: { app: "whatsapp", group: true, name: "Test Crew" },
      kind: "message",
    },
  ]);
  expect(fires(f, message({ chat: GROUP }))).toBe(true);
  expect(fires(f, call({ chat: GROUP }))).toBe(true);
  expect(fires(f, message({ chat: GROUP, source: "telegram" }))).toBe(false);

  const dm = filter({ chat: DM });
  const seen = { [DM]: { name: "Test Ben", source: "whatsapp" } };
  expect(wakesOnOf([dm], ctx({ seen }))).toEqual([
    {
      calls: true,
      chat: { app: "whatsapp", group: false, name: "Test Ben" },
      kind: "message",
    },
  ]);
  // No event of this agent from that chat yet: nothing names it.
  expect(wakesOnOf([dm], ctx())).toEqual([
    {
      calls: true,
      chat: { app: null, group: null, name: null },
      kind: "message",
    },
  ]);
  expect(fires(dm, message({ chat: DM }))).toBe(true);
  expect(fires(dm, message({ chat: GROUP }))).toBe(false);
});

test("words alone, or his own messages, are not calls", () => {
  const words = filter({ text_matches: "invoice" });
  expect(wakesOnOf([words], ctx())).toEqual([
    { calls: false, kind: "message", words: "invoice" },
  ]);
  expect(fires(words, message({ text: "the Invoice" }))).toBe(true);
  expect(fires(words, message())).toBe(false);
  expect(fires(words, call())).toBe(false);

  const his = filter({ from_me: true });
  expect(wakesOnOf([his], ctx())).toEqual([
    { calls: false, fromHim: true, kind: "message" },
  ]);
  expect(fires(his, message({ fromMe: true }))).toBe(true);
  expect(fires(his, message())).toBe(false);
  expect(fires(his, call())).toBe(false);
});

test("an event channel's line carries its own name, quantity, bounds and words", () => {
  const f = filter({
    above: 50,
    below: 200,
    channels: ["payments"],
    quantity: "eur_out",
    text_matches: "bakery",
  });
  expect(wakesOnOf([f], ctx())).toEqual([
    {
      above: 50,
      below: 200,
      kind: "payments",
      quantity: "eur_out",
      words: "bakery",
    },
  ]);
  expect(fires(f, payment())).toBe(true);
  expect(fires(f, payment({ quantities: { eur_out: 20 } }))).toBe(false);
  expect(fires(f, payment({ quantities: { eur_in: 80 } }))).toBe(false);
  expect(fires(f, message())).toBe(false);
  // A quantity its channel does not hold never fires: no line.
  expect(
    wakesOnOf([filter({ channels: ["payments"], quantity: "km" })], ctx())
  ).toEqual([]);
});

test("a filter naming a message app and payments gives a line for each side that can fire", () => {
  const both = filter({ channels: ["whatsapp", "payments"] });
  expect(wakesOnOf([both], ctx())).toEqual([
    { apps: ["whatsapp"], calls: true, kind: "message" },
    { kind: "payments" },
  ]);
  expect(fires(both, message())).toBe(true);
  expect(fires(both, payment())).toBe(true);

  // A quantity stops every message: only payments.
  const quantity = filter({
    channels: ["whatsapp", "payments"],
    quantity: "eur_in",
  });
  expect(wakesOnOf([quantity], ctx())).toEqual([
    { kind: "payments", quantity: "eur_in" },
  ]);
  expect(fires(quantity, message())).toBe(false);
  expect(fires(quantity, payment({ quantities: { eur_in: 5 } }))).toBe(true);

  // A person stops every payment: only the message.
  const person = filter({
    channels: ["whatsapp", "payments"],
    person: "Test Ana",
  });
  expect(wakesOnOf([person], ctx())).toEqual([
    {
      apps: ["whatsapp"],
      calls: true,
      kind: "message",
      party: ana,
      personAsWritten: "Test Ana",
    },
  ]);
  expect(fires(person, payment())).toBe(false);
  expect(fires(person, message())).toBe(true);
});

test("a place gives only the places line, with where; it fires within its radius, never on an event with no point", () => {
  const site = { latitude: 10.5, longitude: 20.5 };
  const arrival = (north: number): Matchable => ({
    channel: "places",
    isNamedOnly: true,
    point: { latitude: site.latitude + north / 111_320, longitude: 20.5 },
    text: "arrived Test Site",
  });
  const f = filter({ channels: ["whatsapp", "payments", "places"], ...site });
  expect(wakesOnOf([f], ctx())).toEqual([
    { kind: "places", near: { ...site, radius_m: 100 } },
  ]);
  expect(fires(f, arrival(90))).toBe(true);
  expect(fires(f, arrival(400))).toBe(false);
  expect(fires({ ...f, radius_m: 500 }, arrival(400))).toBe(true);
  expect(fires(f, payment())).toBe(false);
  expect(fires(f, message())).toBe(false);
});

test("a repo gives only the GitHub line, with its repo; it fires on that repo or its owner's, never on an event with no repo", () => {
  const activity = (repo?: string): Matchable => ({
    channel: "github_activity",
    isNamedOnly: true,
    ...(repo ? { repo } : {}),
    text: "Test release",
  });
  const f = filter({
    channels: ["whatsapp", "github_activity"],
    repo: "Acme/*",
  });
  expect(wakesOnOf([f], ctx())).toEqual([
    { kind: "github_activity", repo: "Acme/*" },
  ]);
  expect(fires(f, activity("acme/app"))).toBe(true);
  expect(fires(f, activity("acmeco/app"))).toBe(false);
  expect(fires({ ...f, repo: "acme/app" }, activity("ACME/App"))).toBe(true);
  expect(fires({ ...f, repo: "acme/app" }, activity("acme/site"))).toBe(false);
  expect(fires(f, activity())).toBe(false);
  expect(fires(f, message())).toBe(false);
  expect(
    fires(filter({ channels: ["github_activity"] }), activity("acme/app"))
  ).toBe(false);
});

test("the lines keep the filters' order, then the open card (with its deadline), then the wide net", () => {
  const card = {
    check: "dec_000000000001",
    deadline: "2026-11-21T09:00:00.000Z",
    question: "Send Ana the quote?",
  };
  const lines = wakesOnOf(
    [filter({ text_matches: "a" }), filter({ person: "Test Ana" })],
    ctx({ cards: [card], hasNet: true })
  );
  expect(lines.map((l) => l.kind)).toEqual([
    "message",
    "message",
    "answer",
    "wide_net",
  ]);
  expect(lines[0]).toMatchObject({ words: "a" });
  expect(lines[1]).toMatchObject({ party: ana });
  expect(wakesOnOf([], ctx({ cards: [card] }))).toEqual([
    {
      card: card.question,
      check: card.check,
      deadline: card.deadline,
      kind: "answer",
    },
  ]);
});
