import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY, MIN } from "../core/clock";
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

test("the holder keeps: the waiting card waits past 10 minutes, until the held card settles; only the holder may keep", async () => {
  const held = await ask(HOLDER);
  const waiting = await ask(ASKER);
  await expect(
    requestDecision(
      "desk",
      { agent: ASKER, keep: waiting.id, why: "mine" },
      later(MIN)
    )
  ).rejects.toThrow("no card waiting on one of yours");
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

test("while his Send of the held card runs, the waiting card keeps waiting past 10 minutes", async () => {
  const held = await ask(HOLDER);
  const waiting = await ask(ASKER);
  let during: string | undefined;
  await answerDecision(held.id, ["send"], undefined, {
    deliver: () => {
      during = of(waiting.id, later(CONTEST_WAIT + 1000))?.state;
      return Promise.resolve("$sent");
    },
    now: later(CONTEST_WAIT),
    via: "connector",
  });
  expect(during).toBe("waiting");
  // Sent, the held card settled: the waiting card is asked, with nothing to replace.
  expect(of(waiting.id, later(CONTEST_WAIT + MIN))).toMatchObject({
    state: "open",
  });
  expect(of(waiting.id, later(CONTEST_WAIT + MIN))?.replaces).toBeUndefined();
});
