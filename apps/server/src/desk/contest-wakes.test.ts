import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { rmSync } from "node:fs";
import { clock, DAY, MIN } from "../core/clock";
// biome-ignore lint/performance/noNamespaceImport: a test reads the registered agents from its own desk
import * as deskRead from "../host/desk-read";
import {
  DECISION_ANSWERED,
  DRAFT_CONTESTED,
  DRAFT_KEPT,
  decisionCursorOf,
  pollDecisions,
} from "../host/events";
import { readRegisteredAgents } from "../host/registered-agents";
import { DECISIONS } from "../memory/decision-lines";
import { answerDecision, requestDecision } from "../memory/decisions";
import { CONTEST_WAIT } from "../memory/draft-contest";
// biome-ignore lint/performance/noNamespaceImport: a test stands in for Life's reading of a draft's chat
import * as draftSend from "../memory/draft-send";
import { askDecision, readCard } from "./agent-actions";
import { nextWakeOf } from "./agent-wait";
import { pollAnswers } from "./desk-clock";
import { advance, ahead, asgOf, on, setup } from "./test-desk";

// The desk's side of a draft's contest, made up: two agents each draft into Noa's group chat.

beforeEach(() => rmSync(DECISIONS, { force: true }));
afterEach(() => {
  setSystemTime();
});

const readChat = () =>
  Promise.resolve({
    channel: "whatsapp",
    chat: "120363@g.us",
    text: "See you at seven",
    to: "Climbing group",
  });
const card = (agent: string, over = {}) => ({
  agent,
  context: "A made-up reason to ask.",
  deadline: ahead(DAY),
  draft: {
    channel: "whatsapp",
    text: "See you at seven",
    to: "Climbing group",
  },
  options: [
    { id: "send", label: "Send it", outgoing: true },
    { id: "skip", label: "Skip" },
  ],
  question: "Send this to the group?",
  title: "Reply to the group",
  ...over,
});
const ask = (agent: string, over = {}) =>
  requestDecision("desk", card(agent, over), undefined, readChat);
const eventsOf = (desk: ReturnType<typeof setup>["desk"], agent: string) =>
  desk.db
    .query<{ event_id: string; name: string; payload: string }, [string]>(
      "select event_id, name, payload from event where assignment_id = ? order by rowid"
    )
    .all(asgOf(desk, agent));

test("a waiting card wakes its holder once, at once, with facts only; the holder reads it at its door, and its keep wakes the asker", async () => {
  const { desk, waiting } = setup();
  const holder = await waiting(DAY);
  const asker = await waiting(DAY);
  pollAnswers(desk);
  const held = await ask(holder);
  const w = await ask(asker);
  pollAnswers(desk);
  pollAnswers(desk);
  const [contested] = eventsOf(desk, holder);
  expect(eventsOf(desk, holder)).toHaveLength(1);
  expect(contested?.name).toBe(DRAFT_CONTESTED);
  expect(JSON.parse(contested?.payload ?? "")).toEqual({
    asker,
    channel: "whatsapp",
    chat: "120363@g.us",
    held: held.id,
    id: w.id,
    until: ahead(CONTEST_WAIT),
  });
  expect(
    nextWakeOf(
      on(desk, holder),
      [],
      [{ ...contested, received_at: ahead(0) } as never]
    )
  ).toMatchObject({
    cause: "answer",
  });
  // The holder reads it, as data; a card in no contest with its own is refused.
  expect(readCard(desk, on(desk, holder), w.id)).toMatchObject({
    asker,
    draft: { text: "See you at seven", to: "Climbing group" },
    kept: null,
  });
  const other = await requestDecision(
    "desk",
    card(asker, {
      draft: undefined,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    })
  );
  expect(() => readCard(desk, on(desk, holder), other.id)).toThrow(
    "in no contest"
  );
  // A keep is the holder's alone, through its own door.
  await expect(
    askDecision(desk, on(desk, asker), { keep: w.id, why: "mine" })
  ).rejects.toThrow("waits on no card of");
  advance(MIN);
  await askDecision(desk, on(desk, holder), {
    keep: w.id,
    why: "mine answers first",
  });
  pollAnswers(desk);
  expect(
    eventsOf(desk, asker).map((e) => [e.name, JSON.parse(e.payload)])
  ).toEqual([[DRAFT_KEPT, { held: held.id, id: w.id }]]);
  expect(readCard(desk, on(desk, asker), w.id).kept).toBe("mine answers first");
});

test("a merged card's answer wakes both agents", async () => {
  const resolved = spyOn(draftSend, "resolveDraft").mockImplementation(
    readChat as never
  );
  const { desk, waiting } = setup();
  const holder = await waiting(DAY);
  const asker = await waiting(DAY);
  pollAnswers(desk);
  await askDecision(desk, on(desk, holder), card(holder) as never);
  const w = await ask(asker);
  advance(MIN);
  const merged = await askDecision(desk, on(desk, holder), {
    ...card(holder),
    merges: w.id,
  } as never);
  advance(MIN);
  // The merged card's agent waits on the combined card, and on a card of its own asked since, each shown once.
  const later = await ask(asker, {
    draft: undefined,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  });
  const read = spyOn(deskRead, "readDesk").mockImplementation(
    (r) => ({ state: "ok", value: r(desk.db) }) as never
  );
  const { agents } = await readRegisteredAgents();
  read.mockRestore();
  expect(
    agents
      .find((a) => a.id === asker)
      ?.wakesOn.flatMap((l) => ("check" in l ? [l.check] : []))
  ).toEqual([merged.id, later.id]);
  await answerDecision(merged.id, ["skip"]);
  advance(MIN);
  pollAnswers(desk);
  const answered = `${merged.id}.answered`;
  expect(eventsOf(desk, holder).map((e) => e.event_id)).toContain(answered);
  expect(
    eventsOf(desk, asker)
      .filter((e) => e.name === DECISION_ANSWERED)
      .map((e) => e.event_id)
  ).toEqual([answered]);
  resolved.mockRestore();
});

// A paired agent asks as itself, with no registered agent.
const PAIRED = "planner";
const askPaired = (over = {}) => {
  const { agent: _, ...paired } = card("");
  return requestDecision(PAIRED, { ...paired, ...over }, undefined, readChat);
};
/** The answers a paired agent's poll from `from` hears, with their words. */
const pairedHears = (from: Date) =>
  pollDecisions(DECISION_ANSWERED, decisionCursorOf(from), PAIRED).events.map(
    (e) => [
      e.eventId,
      e.data.question,
      e.data.onSilence,
      e.data.answer?.options,
    ]
  );
const answersOf = (desk: ReturnType<typeof setup>["desk"], agent: string) =>
  eventsOf(desk, agent)
    .filter((e) => e.name === DECISION_ANSWERED)
    .map((e) => {
      const p = JSON.parse(e.payload);
      return [e.event_id, p.question, p.onSilence, p.answer?.options];
    });

test("a paired holder's merge: his answer wakes the desk agent whose card it merged, once, and the holder hears it", async () => {
  const { desk, waiting } = setup();
  const asker = await waiting(DAY);
  pollAnswers(desk);
  const from = clock();
  await askPaired();
  const w = await ask(asker);
  advance(MIN);
  const merged = await askPaired({ merges: w.id, onSilence: "skip" });
  advance(MIN);
  await answerDecision(merged.id, ["skip"]);
  advance(MIN);
  pollAnswers(desk);
  pollAnswers(desk);
  const answered = `${merged.id}.answered`;
  expect(answersOf(desk, asker)).toEqual([
    [answered, undefined, null, ["skip"]],
  ]);
  expect(pairedHears(from)).toEqual([
    [answered, "Send this to the group?", "skip", ["skip"]],
  ]);
});

test("a desk holder's merge: the paired agent whose card it merged hears his answer, without the holder's words", async () => {
  const resolved = spyOn(draftSend, "resolveDraft").mockImplementation(
    readChat as never
  );
  const { desk, waiting } = setup();
  const holder = await waiting(DAY);
  pollAnswers(desk);
  const from = clock();
  await askDecision(desk, on(desk, holder), card(holder) as never);
  const w = await askPaired();
  advance(MIN);
  const merged = await askDecision(desk, on(desk, holder), {
    ...card(holder),
    merges: w.id,
    onSilence: "skip",
  } as never);
  advance(MIN);
  await answerDecision(merged.id, ["skip"]);
  advance(MIN);
  pollAnswers(desk);
  const answered = `${merged.id}.answered`;
  expect(pairedHears(from)).toEqual([[answered, undefined, null, ["skip"]]]);
  expect(answersOf(desk, holder)).toEqual([
    [answered, "Send this to the group?", "skip", ["skip"]],
  ]);
  resolved.mockRestore();
});
