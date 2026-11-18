import { expect, test } from "bun:test";
import { MIN } from "../core/clock";
import type { SourceEvent } from "../records/source";
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
  draftChats: new Set(),
  lines: new Map(),
  ownerNames: ["Ozren"],
  ...over,
});

/** The gate's word on the units of `events`: "due" or the rule that holds them. */
const gate = (events: SourceEvent[], read = reads()) =>
  arrivalsDue(
    { built: applyRules(messageUnits(events, known)), conversations: [] },
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
    { built: lifelogUnits([c], new Set()), conversations: [c] },
    reads(),
    new Date(NOW)
  ).map((a) => ("wait" in a ? a.wait : "due"));

test("a quiet 1:1 chat with someone he knows is due; once read, it waits until a new line comes", () => {
  const first = msg();
  expect(gate([first])).toEqual(["due"]);
  const [b] = messageUnits([first], known);
  const read = reads({ lines: new Map([[b?.unit.id ?? "", 1]]) });
  expect(gate([first], read)).toEqual(["nothing-new"]);
  expect(
    gate([first, msg({ at: ago(3), text: "And the slides" })], read)
  ).toEqual(["due"]);
});

test("a recording waits while lifelog has not closed it, when he did not speak, and when it is small talk; a closed talk of his is due", () => {
  expect(heard(talk(8, { closed: false }))).toEqual(["open-conversation"]);
  const marked = talk(8, { closed: false });
  marked.turns[0] = {
    ...marked.turns[0],
    marks: ["job-1:0@x"],
  } as (typeof marked.turns)[number];
  expect(heard(marked)).toEqual(["open-conversation"]);
  expect(heard(talk(8, { him: false }))).toEqual(["he-did-not-speak"]);
  expect(heard(talk(5))).toEqual(["small-talk"]);
  expect(heard(talk(6))).toEqual(["due"]);
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
});

test("a receipt from no one he knows and a stranger's message wait; a newsletter is the code rules' drop", () => {
  const mail = (over: Partial<SourceEvent>) =>
    msg({
      chat: "thread-1",
      chatName: "Your order has shipped",
      id: `mail:${nextId()}`,
      sender: "orders@shop.example",
      source: "mail",
      ...over,
    });
  expect(gate([mail({ transaction: true })])).toEqual(["receipt"]);
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

test("his words to Life, an agent's report and a chat a draft was just sent in are always through", () => {
  const stranger = {
    chat: "33600000002@s.whatsapp.net",
    sender: "33600000002",
  };
  expect(gate([msg({ ...stranger, marked: true })])).toEqual(["due"]);
  expect(
    gate([
      msg({
        chat: "agent-1",
        id: "agent:1",
        sender: "agent-1",
        source: "agent",
      }),
    ])
  ).toEqual(["due"]);
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
  expect(
    gate(
      [msg(stranger)],
      reads({ draftChats: new Set(["33600000002@s.whatsapp.net"]) })
    )
  ).toEqual(["due"]);
});

test("a unit held back is the night's: it has no verdict, so the night reads it", () => {
  const held = messageUnits([msg({ at: ago(1) })], known);
  expect(gate([msg({ at: ago(1) })])).toEqual(["still-written"]);
  expect(unread(held, new Map())).toBe(true);
});
