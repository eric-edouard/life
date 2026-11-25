import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import { DAY, HOUR } from "../core/clock";
import { rateDecision, withdrawAnswer } from "./decision-after-answer";
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
  const read = () => decisionsNow(NOW).find((d) => d.id === id);
  expect(deliveryOf(read() ?? {}, NOW)).toEqual({ state: "pending" });
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
  expect(deliveryOf(read() ?? {}, NOW)).toEqual({
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
  expect(deliveryOf({ ask: "Pick one" }, NOW)).toEqual({ state: "delivered" });
});

test("his Undo voids his answer and opens the card; an answer whose act wrote outside Life is never undone; his mark only on an answered card", async () => {
  const { id } = await card();
  expect(() => withdrawAnswer(id)).toThrow("no answer");
  expect(() => rateDecision(id, "good")).toThrow("not answered");
  await answerDecision(id, ["tue"], undefined, { now: NOW });
  withdrawAnswer(id, undefined, NOW);
  expect(stateOf(id)).toBe("open");
  await answerDecision(id, ["wed"], undefined, { now: NOW });
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
