import { expect, test } from "bun:test";
import { MIN } from "../core/clock";
import { eventKey, type SourceEvent } from "../records/source";
import type { LifelogConversation } from "../sources/lifelog";
import { type ArrivalReads, arrivalsDue } from "./arrival-gate";
import { unread } from "./episodes";
import { applyRules, lifelogUnits, messageUnits } from "./units";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
const SAM = "33600000001@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const known = (handle: string) =>
  handle === SAM || handle === "sam@example.com" ? "person:sam" : null;

let n = 0;
const nextId = () => {
  n += 1;
  return n;
};
const msg = (over: Partial<SourceEvent> = {}): SourceEvent => ({
  at: ago(5),
  chat: SAM,
  fromMe: false,
  id: `whatsapp:${nextId()}`,
  sender: SAM,
  source: "whatsapp",
  text: "Can you send me the transcript tonight?",
  ...over,
});

const reads = (over: Partial<ArrivalReads> = {}): ArrivalReads => ({
  ownerNames: ["Ozren"],
  read: new Set(),
  ...over,
});

/** The gate's word on the units of `events`: "due" or the rule that holds them. */
const gate = (events: SourceEvent[], read = reads()) =>
  arrivalsDue(
    { built: applyRules(messageUnits(events, known)) },
    read,
    new Date(NOW)
  ).map((a) => ("wait" in a ? a.wait : "due"));

const talk = (
  turns: number,
  { closed = true, him = true } = {}
): LifelogConversation => ({
  closed,
  endedAt: ago(10),
  id: "conv-1",
  startedAt: ago(40),
  turns: Array.from({ length: turns }, (_, i) => ({
    at: ago(40 - i),
    end: null,
    jobId: "job-1",
    marks: [],
    name: "Sam",
    owner: him && i % 2 === 0,
    personId: null,
    seen: null,
    turnIndex: i,
  })),
});
const heard = (c: LifelogConversation) =>
  arrivalsDue(
    { built: lifelogUnits([c], new Set()) },
    reads(),
    new Date(NOW)
  ).map((a) => ("wait" in a ? a.wait : "due"));

test("a quiet 1:1 chat with someone he knows is due; once read, it waits until a new line comes", () => {
  const first = msg();
  expect(gate([first])).toEqual(["due"]);
  const read = reads({ read: new Set([eventKey(first)]) });
  expect(gate([first], read)).toEqual(["nothing-new"]);
  expect(
    gate([first, msg({ at: ago(3), text: "And the slides" })], read)
  ).toEqual(["due"]);
});

test("a recording is the night's: voice waits for a measured cut of its own", () => {
  expect(heard(talk(8))).toEqual(["night-only"]);
});

test("a chat still being written waits, unless its first unread line has waited 10 minutes", () => {
  expect(gate([msg({ at: ago(1) })])).toEqual(["still-written"]);
  expect(gate([msg({ at: ago(11) }), msg({ at: ago(1) })])).toEqual(["due"]);
});

test("a group he wrote nothing in waits, unless a new line names him", () => {
  const group = (text: string) =>
    msg({ chat: GROUP, chatName: "Climbing", text });
  expect(gate([group("Who brings the rope on Sunday?")])).toEqual([
    "group-not-his",
  ]);
  expect(gate([group("Ozren, can you bring the rope?")])).toEqual(["due"]);
  expect(gate([group("Ozrenka, can you bring the rope?")])).toEqual([
    "group-not-his",
  ]);
});

test("a receipt or a message from no one he knows waits; a newsletter is the code rules' drop", () => {
  const mail = (over: Partial<SourceEvent>) =>
    msg({
      chat: "thread-1",
      chatName: "Your order has shipped",
      id: `mail:${nextId()}`,
      sender: "orders@shop.example",
      source: "mail",
      ...over,
    });
  expect(gate([mail({ transaction: true })])).toEqual(["stranger"]);
  expect(gate([mail({ bulk: true })])).toEqual(["dropped"]);
  expect(
    gate([msg({ chat: "33600000002@s.whatsapp.net", sender: "33600000002" })])
  ).toEqual(["stranger"]);
});

test("notes wait for the night whatever they say", () => {
  expect(
    gate([msg({ chat: "note-1", id: "notes:1", source: "notes" })])
  ).toEqual(["night-only"]);
});

test("his words to Life and an agent's report are always through", () => {
  const stranger = {
    chat: "33600000002@s.whatsapp.net",
    sender: "33600000002",
  };
  expect(gate([msg({ ...stranger, marked: true })])).toEqual(["due"]);
  expect(
    gate([
      msg({
        chat: "thread-2",
        chatName: "Done: the transcript",
        id: "mail:report",
        sender: "alerts@agents.example.test",
        source: "mail",
      }),
    ])
  ).toEqual(["due"]);
});

test("a unit held back is the night's: it has no verdict, so the night reads it", () => {
  const held = messageUnits([msg({ at: ago(1) })], known);
  expect(gate([msg({ at: ago(1) })])).toEqual(["still-written"]);
  expect(unread(held, new Map())).toBe(true);
});
