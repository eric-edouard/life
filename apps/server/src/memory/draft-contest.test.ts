import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { clock, DAY, MIN } from "../core/clock";
import { logEvents, logFileOf } from "../core/log";
import {
  answerDecision,
  DECISIONS,
  decisionsNow,
  requestDecision,
  settledBetween,
} from "./decisions";
import { CONTEST_WAIT } from "./draft-contest";

// A draft's contest, made up: two agents each draft into Noa's group chat.

const NOW = new Date("2026-11-21T09:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const HOLDER = "agt_0a0a";
const ASKER = "agt_0b0b";
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
  deadline: later(2 * DAY).toISOString(),
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
const ask = (agent: string, at = NOW, over = {}) =>
  requestDecision("desk", card(agent, over), at, readChat);
const of = (id: string, at = NOW) => decisionsNow(at).find((d) => d.id === id);

beforeEach(() => rmSync(DECISIONS, { force: true }));
afterEach(() => rmSync(DECISIONS, { force: true }));

test("a draft into a chat another agent's open card holds waits on it, out of his inbox, and says until when", async () => {
  const held = await ask(HOLDER);
  // The same agent's second draft into its own card's chat is refused.
  await expect(ask(HOLDER)).rejects.toThrow(`${held.id} already asks a draft`);
  const waiting = await ask(ASKER);
  expect(waiting.waits).toMatchObject({
    on: held.id,
    until: later(CONTEST_WAIT).toISOString(),
  });
  expect(of(waiting.id)).toMatchObject({ contests: held.id, state: "waiting" });
  // A third into a chat where one waits is refused.
  await expect(ask("agt_0c0c")).rejects.toThrow(
    `${waiting.id} already waits to ask`
  );
});

test("the holder yields: once its card is withdrawn, the waiting card is asked", async () => {
  const held = await ask(HOLDER);
  const waiting = await ask(ASKER);
  await requestDecision(
    "desk",
    { agent: HOLDER, why: "yours says it", withdraw: held.id },
    later(MIN)
  );
  expect(of(waiting.id, later(2 * MIN))).toMatchObject({ state: "open" });
  expect(of(waiting.id, later(2 * MIN))?.replaces).toBeUndefined();
});

test("the holder keeps: the waiting card waits past 10 minutes, until the held card settles (only its holder: the door checks)", async () => {
  const held = await ask(HOLDER);
  const waiting = await ask(ASKER);
  await requestDecision(
    "desk",
    { agent: HOLDER, keep: waiting.id, why: "mine answers first" },
    later(MIN)
  );
  expect(of(waiting.id, later(DAY))).toMatchObject({
    kept: { why: "mine answers first" },
    state: "waiting",
  });
  // Its own asker may still withdraw it.
  await requestDecision(
    "desk",
    { agent: ASKER, why: "fine", withdraw: waiting.id },
    later(2 * MIN)
  );
  expect(of(waiting.id, later(3 * MIN))?.state).toBe("withdrawn");
  expect(of(held.id, later(3 * MIN))?.state).toBe("open");
});

test("the holder merges: one card for both withdraws its own, and the waiting card is withdrawn for it, replaced by the merged card", async () => {
  const held = await ask(HOLDER);
  const waiting = await ask(ASKER);
  // Its one card per chat is the card it merges away.
  const merged = await ask(HOLDER, later(MIN), { merges: waiting.id });
  expect(merged.waits).toBeUndefined();
  const list = decisionsNow(later(2 * MIN));
  expect(list.find((d) => d.id === held.id)?.state).toBe("withdrawn");
  expect(list.find((d) => d.id === merged.id)?.state).toBe("open");
  expect(list.find((d) => d.id === waiting.id)).toMatchObject({
    state: "withdrawn",
    withdrawn: { replacedBy: merged.id },
  });
  // Its asker hears it withdrawn (for it); the holder's own withdrawal is its own act.
  expect(settledBetween(list, NOW, later(2 * MIN)).map((d) => d.id)).toEqual([
    waiting.id,
  ]);
  // One `decision.withdrawn` line for each card the merge withdrew.
  const withdrawn = logEvents(
    logFileOf(clock().toISOString()),
    "decision.withdrawn"
  ).filter((l) => l.id === held.id || l.id === waiting.id);
  expect(withdrawn.map((l) => [l.id, l.by])).toEqual([
    [held.id, "merge"],
    [waiting.id, "merge"],
  ]);
  await expect(ask(ASKER, later(MIN), { merges: merged.id })).rejects.toThrow(
    "no card waiting on one of yours"
  );
});

test("silent 10 minutes, the waiting card is asked replacing the held one; his Send withdraws that one before it goes, and its asker hears it", async () => {
  const held = await ask(HOLDER);
  const waiting = await ask(ASKER);
  expect(of(waiting.id, later(CONTEST_WAIT - 1))?.state).toBe("waiting");
  const at = later(CONTEST_WAIT);
  expect(of(waiting.id, at)).toMatchObject({
    replaces: held.id,
    state: "open",
  });
  // Both are open now: his Send on the newer one sends it alone.
  const sentWhile: string[] = [];
  await answerDecision(waiting.id, ["send"], undefined, {
    deliver: () => {
      sentWhile.push(String(of(held.id, at)?.state));
      return Promise.resolve("$sent");
    },
    now: at,
    via: "connector",
  });
  expect(sentWhile).toEqual(["withdrawn"]);
  const list = decisionsNow(later(CONTEST_WAIT + MIN));
  expect(list.find((d) => d.id === held.id)?.withdrawn).toMatchObject({
    replacedBy: waiting.id,
  });
  expect(
    settledBetween(list, at, later(CONTEST_WAIT + MIN)).map((d) => d.id)
  ).toContain(held.id);
});

test("his Send of the held card withdraws the card waiting on it, replaced by it", async () => {
  const held = await ask(HOLDER);
  const waiting = await ask(ASKER);
  await answerDecision(held.id, ["send"], undefined, {
    deliver: () => Promise.resolve("$sent"),
    now: later(MIN),
    via: "connector",
  });
  expect(of(waiting.id, later(2 * MIN))?.withdrawn?.replacedBy).toBe(held.id);
});

test("a card asked while his Send of the held card runs waits on it; a merged card stays withdrawn past its deadline", async () => {
  const held = await ask(HOLDER);
  let during: string | undefined;
  await answerDecision(held.id, ["send"], undefined, {
    deliver: async () => {
      const w = await ask(ASKER, later(MIN));
      during = `${of(w.id, later(2 * MIN))?.state} on ${of(w.id, later(2 * MIN))?.contests}`;
      return "$sent";
    },
    now: later(MIN),
    via: "connector",
  });
  expect(during).toBe(`waiting on ${held.id}`);
  rmSync(DECISIONS);
  const a = await ask(HOLDER);
  const w = await ask(ASKER);
  const m = await ask(HOLDER, later(MIN), { merges: w.id });
  expect(of(w.id, later(3 * DAY))).toMatchObject({
    state: "withdrawn",
    withdrawn: { replacedBy: m.id },
  });
  expect(of(a.id, later(2 * MIN))?.state).toBe("withdrawn");
});

test("three askers in turn: his Send withdraws every other open card into the chat", async () => {
  const a = await ask(HOLDER);
  const b = await ask(ASKER);
  // Past 10 minutes both are open; a third asker contests the newest.
  const c = await ask("agt_0c0c", later(CONTEST_WAIT));
  const at = later(2 * CONTEST_WAIT);
  expect(of(c.id, at)).toMatchObject({ replaces: b.id, state: "open" });
  await answerDecision(c.id, ["send"], undefined, {
    deliver: () => Promise.resolve("$sent"),
    now: at,
    via: "connector",
  });
  const list = decisionsNow(later(2 * CONTEST_WAIT + MIN));
  for (const id of [a.id, b.id]) {
    expect(list.find((d) => d.id === id)?.withdrawn?.replacedBy).toBe(c.id);
  }
});

test("no merge happens while the held card's send runs", async () => {
  const held = await ask(HOLDER);
  let refused: unknown;
  await answerDecision(held.id, ["send"], undefined, {
    deliver: async () => {
      const w = await ask(ASKER, later(MIN));
      refused = await ask(HOLDER, later(MIN), { merges: w.id }).catch(
        (e: Error) => e.message
      );
      return "$sent";
    },
    now: later(MIN),
    via: "connector",
  });
  expect(String(refused)).toContain("no card waiting on one of yours");
});
