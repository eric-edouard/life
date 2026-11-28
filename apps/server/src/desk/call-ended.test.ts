import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY, MIN } from "../core/clock";
import { queuedEvents } from "../host/desk-read";
import type { SourceEvent } from "../records/source";
import { apply, openStore, Page } from "../sources/voice-server";
import {
  conversation,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { openAssignment } from "./agent-actions";
import { EVENTS_SETTLE } from "./agent-wait";
import { pollCalls, pollMessages, readPeopleOnce, wakeDue } from "./desk-clock";
import { openDesk, writeWait } from "./desk-store";
import { ANA, advance, ahead, asgOf, chatSource, setup, T0 } from "./test-desk";

// The wait contract's call.ended: a call with an agent's people wakes it once its words are in, by lifelog's signals.
// Made-up chat, calls and recordings; the watcher's store is a fresh one in a temp folder.

afterEach(() => {
  setSystemTime();
});

const at = (min: number) => new Date(T0 + min * MIN).toISOString();

const call = (startMin: number, seconds = 600): SourceEvent => ({
  at: at(startMin),
  chat: "Test Ana",
  fromMe: true,
  id: `whatsapp:call${startMin}`,
  phoneCall: { seconds, video: false },
  sender: "me",
  source: "whatsapp",
  text: "",
});

/** A desk with a waiting agent (created at T0), the chat's calls in `calls`, an empty watcher store. */
async function calling() {
  const s = setup();
  const calls: SourceEvent[] = [];
  s.desk.sources = [chatSource(calls)];
  const agent = await s.waiting();
  const watch = mkdtempSync(join(tmpdir(), "life-watch-"));
  const store = openStore(watch);
  const poll = () =>
    pollCalls(s.desk, readPeopleOnce(), clock().getTime(), watch);
  const heard = (over: Record<string, unknown>) =>
    apply(store, Page.parse(pageFixture(over)));
  const queued = () =>
    queuedEvents(s.desk.db, asgOf(s.desk, agent)).filter(
      (e) => e.name === "call.ended"
    );
  return { ...s, agent, calls, heard, poll, queued, store, watch };
}

const job = (id: string, firstPage: number) => ({
  id,
  pages: [[firstPage, firstPage + 1]],
  sourceId: "phone-1",
  state: "completed",
});

const turn = (jobId: string, index: number, min: number, conv = "c1") => ({
  ...turnFixture(index, at(min), null, null, conv),
  jobId,
});

test("a call that ended with its words in queues one call.ended: facts and recordings, no word", async () => {
  const { agent, calls, heard, poll, queued, desk, path } = await calling();
  calls.push(call(5)); // 5 to 15 minutes in
  heard({
    conversations: [conversation("c1"), conversation("c2")],
    jobs: [job("j1", 1), job("j2", 5)],
    turns: [turn("j1", 0, 6), turn("j1", 1, 9), turn("j2", 0, 30, "c2")],
  });
  advance(60 * MIN);
  await poll();
  await poll();
  expect(queued()).toHaveLength(1);
  const [row] = queued();
  expect(row?.event_id).toBe("whatsapp:call5.ended");
  const payload = JSON.parse(row?.payload ?? "{}");
  expect(Object.keys(payload).sort()).toEqual([
    "at",
    "chat",
    "id",
    "people",
    "person",
    "recordings",
    "source",
    "until",
    "video",
  ]);
  expect([payload.at, payload.until]).toEqual([at(5), at(15)]);
  expect(payload.recordings).toEqual([{ turn: `j1:0@${at(6)}`, turns: 2 }]);
  expect(row?.payload).not.toContain("hello");
  // A desk reopened on the same store hears it as already queued.
  desk.db.close();
  desk.db = openDesk(path);
  await poll();
  expect(queued()).toHaveLength(1);
  expect(agent).toBeTruthy();
});

test("an agent created after the call gets nothing", async () => {
  const { calls, heard, poll, queued, desk } = await calling();
  calls.push(call(5));
  heard({
    conversations: [conversation("c1"), conversation("c2")],
    jobs: [job("j1", 1), job("j2", 5)],
    turns: [turn("j1", 0, 6), turn("j2", 0, 30, "c2")],
  });
  desk.db.run("update assignment set opened_at = ?", [at(16)]);
  advance(60 * MIN);
  await poll();
  expect(queued()).toHaveLength(0);
});

test("a call with no recording inside, or whose words are not in, queues nothing until they are", async () => {
  const { calls, heard, poll, queued } = await calling();
  calls.push(call(5));
  advance(60 * MIN);
  await poll();
  expect(queued()).toHaveLength(0); // nothing heard inside
  heard({
    conversations: [conversation("c1"), conversation("c2")],
    jobs: [job("j1", 1)],
    turns: [turn("j1", 0, 6)],
  });
  await poll();
  expect(queued()).toHaveLength(0); // no silence, no closing, no later turn: the recording may go on
  heard({
    conversations: [conversation("c2")],
    jobs: [job("j2", 5)],
    turns: [turn("j2", 0, 30, "c2")],
  });
  await poll();
  expect(queued()).toHaveLength(1);
});

test("a message and the call that ended make one turn that says both", async () => {
  const { agent, calls, desk, fake, heard, poll, queued, turns } =
    await calling();
  await pollMessages(desk, readPeopleOnce()); // the message cursor starts now
  calls.push(call(5), {
    ...call(5),
    at: at(20),
    fromMe: false,
    id: "whatsapp:m1",
    phoneCall: undefined,
    text: "ok",
  });
  heard({
    conversations: [conversation("c1"), conversation("c2")],
    jobs: [job("j1", 1), job("j2", 5)],
    turns: [turn("j1", 0, 6), turn("j2", 0, 30, "c2")],
  });
  advance(30 * MIN);
  await pollMessages(desk, readPeopleOnce());
  await poll();
  expect(queued()).toHaveLength(1);
  advance(EVENTS_SETTLE);
  await wakeDue(desk);
  const said = fake.said.at(-1)?.message ?? "";
  expect(said).toContain("message.received");
  expect(said).toContain("call.ended");
  expect(turns(agent)).toHaveLength(2);
});

test("two calls that ended make one wake that carries both", async () => {
  const { agent, calls, desk, fake, heard, poll, queued, turns } =
    await calling();
  calls.push(call(5), call(20));
  heard({
    conversations: [conversation("c1"), conversation("c2"), conversation("c3")],
    jobs: [job("j1", 1), job("j2", 5), job("j3", 9)],
    turns: [turn("j1", 0, 6), turn("j2", 0, 22, "c2"), turn("j3", 0, 40, "c3")],
  });
  advance(50 * MIN); // before its deadline (60 minutes), so the wake is the calls'
  await poll();
  expect(queued().map((e) => e.event_id)).toEqual([
    "whatsapp:call5.ended",
    "whatsapp:call20.ended",
  ]);
  await wakeDue(desk);
  expect(turns(agent)).toHaveLength(1);
  advance(EVENTS_SETTLE);
  await wakeDue(desk);
  expect(turns(agent)).toHaveLength(2);
  expect(turns(agent).at(-1)?.cause).toBe("event");
  expect(fake.said.at(-1)?.message.match(/call\.ended/g)).toHaveLength(2);
});

test("a call the agent's own wait and its matter's both want wakes the matter's, once, poll after poll", async () => {
  const { agent, calls, desk, heard, poll, queued } = await calling();
  const matter = openAssignment(desk, agent, {
    openedBy: "owner",
    steps: ["obs_test_call"],
  });
  writeWait(
    desk.db,
    matter,
    { events: [ANA], reason: "r", until: ahead(DAY) },
    false
  );
  calls.push(call(5));
  heard({
    conversations: [conversation("c1"), conversation("c2")],
    jobs: [job("j1", 1), job("j2", 5)],
    turns: [turn("j1", 0, 6), turn("j2", 0, 30, "c2")],
  });
  advance(60 * MIN);
  await poll();
  await poll();
  expect(queued()).toEqual([]);
  expect(queuedEvents(desk.db, matter).map((e) => e.event_id)).toEqual([
    "whatsapp:call5.ended",
  ]);
});
