import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import { DAY, HOUR } from "../core/clock";
import {
  rateDecision,
  rateOffersOf,
  withdrawAnswer,
} from "./decision-after-answer";
import { deliveryOf, recordDelivered } from "./decision-delivery";
import { DECISIONS, DECISIONS_VERSION } from "./decision-lines";
import { answerDecision, decisionsNow, requestDecision } from "./decisions";

// Made-up cards throughout.

const NOW = new Date("2026-11-18T09:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const card = (over = {}) =>
  requestDecision(
    "desk",
    {
      agent: "agt_0123456789ab",
      ask: "Pick a day for the plumber",
      context: "A made-up reason to ask.",
      deadline: later(2 * DAY).toISOString(),
      follow: [],
      onSilence: null,
      options: [
        { id: "tue", label: "Tuesday" },
        { id: "wed", label: "Wednesday" },
      ],
      question: "Which day suits you?",
      recommended: "tue",
      title: "Book the plumber",
      ...over,
    },
    NOW
  );
const stateOf = (id: string, at = NOW) =>
  decisionsNow(at).find((d) => d.id === id)?.state;

beforeEach(() => rmSync(DECISIONS, { force: true }));
afterEach(() => rmSync(DECISIONS, { force: true }));

test("an agent's card not gated yet is pending yet open; held it is in no list until its time; sent back it never is; delivered, open", async () => {
  const { id } = await card();
  const read = () => {
    const d = decisionsNow(NOW).find((x) => x.id === id);
    if (!d) {
      throw new Error("no card");
    }
    return d;
  };
  expect(deliveryOf(read(), NOW)).toEqual({ state: "pending" });
  // Ungated 10 minutes on (the desk off, its tick failing): delivered all the same, never pending forever.
  expect(deliveryOf(read(), later(10 * 60_000))).toEqual({
    state: "delivered",
  });
  expect(stateOf(id)).toBe("open");
  expect(() => recordDelivered(id, { verdict: "hold" }, NOW)).toThrow(
    "until when"
  );
  recordDelivered(
    id,
    {
      readings: { importance: 2 },
      until: later(HOUR).toISOString(),
      verdict: "hold",
    },
    NOW
  );
  expect(stateOf(id)).toBe("held");
  expect(stateOf(id, later(HOUR))).toBe("open");
  recordDelivered(id, { silent: true, verdict: "deliver" }, NOW);
  expect(deliveryOf(read(), NOW)).toEqual({
    silent: true,
    state: "delivered",
  });
  const { id: back } = await card({ question: "Which day, again?" });
  recordDelivered(
    back,
    { note: "Ask with the dates", verdict: "send_back" },
    NOW
  );
  expect(stateOf(back)).toBe("sent_back");
  // His own card never waits on the gate.
  expect(deliveryOf({ ask: "Pick one", at: NOW.toISOString() }, NOW)).toEqual({
    state: "delivered",
  });
});

test("his Undo voids his answer and opens the card; an answer whose act wrote outside Life is never undone; his mark only on an answered card", async () => {
  const { id } = await card();
  expect(() => withdrawAnswer(id)).toThrow("no answer");
  expect(() => rateDecision(id, "good")).toThrow("not answered");
  await answerDecision(id, ["tue"], undefined, { now: NOW });
  withdrawAnswer(id, undefined, NOW);
  expect(stateOf(id)).toBe("open");
  await answerDecision(id, ["wed"], undefined, { now: NOW, via: "connector" });
  expect(decisionsNow(NOW).find((d) => d.id === id)?.answer?.options).toEqual([
    "wed",
  ]);
  rateDecision(id, "good", NOW);
  expect(decisionsNow(NOW).find((d) => d.id === id)?.rated?.mark).toBe("good");
  appendFileSync(
    DECISIONS,
    `${JSON.stringify({ at: NOW.toISOString(), id, kind: "ended", schemaVersion: DECISIONS_VERSION })}\n`
  );
  expect(() => withdrawAnswer(id)).toThrow("already ended");
  expect(stateOf(id)).toBe("answered");
});

test("How am I doing? asks once a day, on the first card he answered in the app; a card not offered takes no mark", async () => {
  const first = await card();
  const second = await card();
  const inSession = await card();
  await answerDecision(inSession.id, ["tue"], undefined, { now: NOW });
  await answerDecision(first.id, ["tue"], undefined, {
    now: later(HOUR),
    via: "connector",
  });
  await answerDecision(second.id, ["tue"], undefined, {
    now: later(2 * HOUR),
    via: "connector",
  });
  const offers = rateOffersOf(decisionsNow(NOW));
  expect([...offers.keys()]).toEqual([first.id]);
  expect(() => rateDecision(second.id, "bad")).toThrow("did not ask");
  rateDecision(first.id, "okay", NOW);
  expect(rateOffersOf(decisionsNow(NOW)).get(first.id)?.mark).toBe("okay");
});
