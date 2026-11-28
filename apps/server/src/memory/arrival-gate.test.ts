import { expect, test } from "bun:test";
import { MIN } from "../core/clock";
import { eventKey, type SourceEvent } from "../records/source";
import type { VoiceConversation } from "../sources/voice-server";
import { type ArrivalReads, arrivalsDue } from "./arrival-gate";
import { unread } from "./episodes";
import { applyRules, messageUnits, voiceUnitsOf } from "./units";

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
): VoiceConversation => ({
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
const heard = (c: VoiceConversation) =>
  arrivalsDue(
    { built: voiceUnitsOf([c], new Set()) },
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

test("mail is due at once whoever sent it, a stranger's chat too; an automated message never is", () => {
  const mail = (over: Partial<SourceEvent>) =>
    msg({
      chat: "thread-1",
      chatName: "Your order has shipped",
      id: `mail:${nextId()}`,
      sender: "orders@shop.example",
      source: "mail",
      ...over,
    });
  expect(gate([mail({ transaction: true })])).toEqual(["due"]);
  expect(
    gate([mail({ sender: "rae@mail.example", text: "Could we meet Friday?" })])
  ).toEqual(["due"]);
  expect(gate([mail({ bulk: true })])).toEqual(["dropped"]);
  expect(gate([mail({ sender: "no-reply@shop.example" })])).toEqual([
    "dropped",
  ]);
  expect(
    gate([msg({ chat: "33600000002@s.whatsapp.net", sender: "33600000002" })])
  ).toEqual(["due"]);
});

/** The texts the gate lets a read show, for the one unit of `events`. */
const freshTexts = (events: SourceEvent[]) =>
  arrivalsDue(
    { built: applyRules(messageUnits(events, known)) },
    reads(),
    new Date(NOW)
  ).flatMap((a) => ("due" in a ? a.fresh.map((m) => m.text) : []));

test("another person's line he answered is never read; his own lines and what came after his last are", () => {
  const ask = msg({ at: ago(30), text: "Lmk where you decide tonight" });
  const his = msg({
    at: ago(25),
    fromMe: true,
    sender: "me",
    text: "Let's try out the new place by the river",
  });
  expect(freshTexts([ask, his])).toEqual([his.text]);
  const later = msg({ at: ago(5), text: "Great, and can you book a table?" });
  expect(freshTexts([ask, his, later])).toEqual([his.text, later.text]);
});

test("a login code in a chat is never read, the person's other lines are", () => {
  const code = msg({ at: ago(6), text: "Your verification code is 482913" });
  expect(freshTexts([msg({ at: ago(7) }), code])).toEqual([
    "Can you send me the transcript tonight?",
  ]);
});

test("a work tracker's thread (GitHub) is never an arrival: agents wait on it instead", () => {
  expect(
    gate([
      msg({
        chat: "acme/app#12",
        id: "github:1",
        sender: "octo",
        source: "github",
        text: "Ozren, can you review this pull request today?",
      }),
    ])
  ).toEqual(["night-only"]);
});

test("notes wait for the night whatever they say", () => {
  expect(
    gate([msg({ chat: "note-1", id: "notes:1", source: "notes" })])
  ).toEqual(["night-only"]);
});

test("his words to Life are always through; his agents' report is skipped per message, a person's line in its thread still read", () => {
  const stranger = {
    chat: "33600000002@s.whatsapp.net",
    sender: "33600000002",
  };
  expect(gate([msg({ ...stranger, marked: true })])).toEqual(["due"]);
  const report = {
    chat: "thread-2",
    chatName: "Done: the transcript",
    source: "mail" as const,
  };
  const fromAgent = msg({
    ...report,
    at: ago(8),
    id: "mail:report",
    sender: "alerts@agents.example.test",
  });
  expect(gate([fromAgent])).toEqual(["nothing-new"]);
  expect(
    freshTexts([
      fromAgent,
      msg({
        ...report,
        id: "mail:sam",
        sender: "sam@example.com",
        text: "Thanks, can you also send the slides?",
      }),
    ])
  ).toEqual(["Thanks, can you also send the slides?"]);
});

test("a unit held back is the night's: it has no verdict, so the night reads it", () => {
  const held = messageUnits([msg({ at: ago(1) })], known);
  expect(gate([msg({ at: ago(1) })])).toEqual(["still-written"]);
  expect(unread(held, new Map())).toBe(true);
});
