import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DAY, HOUR } from "../core/clock";
import {
  answerDecision,
  DECISIONS,
  decisionsNow,
  pushDueOf,
  requestDecision,
  settledBetween,
} from "./decisions";

const DECISION_ID = /^dec_[0-9a-f]{12}$/;
const NOW = new Date("2026-11-18T09:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const ask = (over = {}) => ({
  context: "Kit's quote came in at 400 euros.",
  deadline: later(2 * DAY).toISOString(),
  links: ["https://example.com/session/1"],
  onSilence: "wait",
  options: [
    { id: "yes", label: "Book Kit" },
    { id: "wait", label: "Wait for a second quote" },
  ],
  question: "Book Kit to fix the boiler?",
  title: "Fix the boiler",
  ...over,
});
const draft = { channel: "whatsapp", text: "Can you come Friday?", to: "Kit" };
/** Life's reading of a draft's chat, made up: Kit's one WhatsApp chat. */
const readChat = () =>
  Promise.resolve({
    chat: "155@s.whatsapp.net",
    name: "Kit Moreau",
    source: "whatsapp" as const,
  });
const stateOf = (id: string, at = NOW) =>
  decisionsNow(at).find((d) => d.id === id)?.state;

beforeEach(() => rmSync(DECISIONS, { force: true }));
afterEach(() => setSystemTime());

test("a decision is open until its deadline, then lapsed; an answer after it is refused", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  expect(id).toMatch(DECISION_ID);
  expect(stateOf(id)).toBe("open");
  expect(stateOf(id, later(2 * DAY))).toBe("lapsed");
  await expect(
    answerDecision(id, ["yes"], undefined, { now: later(3 * DAY) })
  ).rejects.toThrow("lapsed");
});

test("the first answer stands; a second is refused", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  await answerDecision(id, ["yes"], undefined, { now: later(HOUR) });
  await expect(
    answerDecision(id, ["wait"], undefined, { now: later(2 * HOUR) })
  ).rejects.toThrow("answered");
  const [d] = decisionsNow(later(3 * DAY));
  expect(d?.state).toBe("answered");
  expect(d?.answer?.options).toEqual(["yes"]);
});

test("an answer is option ids, or none with his words; an unknown option is refused", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  await expect(
    answerDecision(id, ["maybe"], undefined, { now: NOW })
  ).rejects.toThrow("maybe");
  await expect(answerDecision(id, [], undefined, { now: NOW })).rejects.toThrow(
    "note"
  );
  await answerDecision(id, [], "Ask Ana first", { now: NOW });
  expect(decisionsNow(NOW)[0]?.answer?.note).toBe("Ask Ana first");
});

test("only its asker withdraws a decision, while it is open", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  await expect(
    requestDecision("other", { why: "done", withdraw: id }, NOW)
  ).rejects.toThrow("another agent");
  await requestDecision("planner", { why: "Kit cancelled", withdraw: id }, NOW);
  expect(stateOf(id)).toBe("withdrawn");
  await expect(
    answerDecision(id, ["yes"], undefined, { now: NOW })
  ).rejects.toThrow("withdrawn");
});

test("a request is one card: one-line title and question, a draft only with its sending option outgoing, never outgoing on silence", async () => {
  const refused = (over: object, why: string) =>
    expect(requestDecision("planner", ask(over), NOW)).rejects.toThrow(why);
  await refused({ title: "x".repeat(81) }, "title");
  await refused({ title: "Fix\nthe boiler" }, "one line");
  await refused({ question: "x".repeat(121) }, "question");
  await refused({ draft: { text: "Can you come Friday?" } }, "to");
  await refused({ draft: { to: "Kit" } }, "text");
  const send = { id: "send", label: "Send it", outgoing: true as const };
  await refused({ draft }, "outgoing");
  await refused(
    {
      draft,
      onSilence: null,
      options: [send, { ...send, id: "also", label: "Also send" }],
    },
    "the one option"
  );
  await refused(
    {
      draft,
      onSilence: "send",
      options: [send, { id: "wait", label: "Wait" }],
    },
    "never takes an `outgoing` option"
  );
  await requestDecision(
    "planner",
    ask({ draft, options: [send, { id: "wait", label: "Wait" }] }),
    NOW,
    readChat
  );
  // His card names the chat Life resolved; the stored chat is what is sent to.
  expect(decisionsNow(NOW)[0]?.draft).toEqual({
    channel: "whatsapp",
    chat: "155@s.whatsapp.net",
    text: draft.text,
    to: "Kit Moreau",
  });
  // A chat Life can't name is refused when asked, never at send time.
  await expect(
    requestDecision(
      "planner",
      ask({ draft, options: [send, { id: "wait", label: "Wait" }] }),
      NOW,
      () => Promise.reject(new Error("Not done: Kit has 2 chats on whatsapp"))
    )
  ).rejects.toThrow("2 chats");
});

/** A card whose draft Life resolved to a made-up chat, its sending option first. */
const draftCard = () =>
  requestDecision(
    "planner",
    ask({
      draft,
      onSilence: "wait",
      options: [
        { id: "send", label: "Send it", outgoing: true },
        { id: "wait", label: "Wait" },
      ],
    }),
    NOW,
    readChat
  );

test("his answer to a draft's outgoing option alone sends its exact text once, into the chat named; a second answer sends nothing", async () => {
  const sent: string[][] = [];
  const deliver = (...a: string[]) => {
    sent.push(a);
    return Promise.resolve("$event1");
  };
  const { id } = await draftCard();
  const done = await answerDecision(id, ["send"], undefined, {
    deliver,
    now: later(HOUR),
  });
  expect(sent).toEqual([
    ["whatsapp", "155@s.whatsapp.net", "Can you come Friday?", id],
  ]);
  expect(done.at(-1)).toMatchObject({ eventId: "$event1", kind: "sent" });
  await expect(
    answerDecision(id, ["send"], undefined, { deliver, now: later(HOUR) })
  ).rejects.toThrow("answered");
  expect(sent).toHaveLength(1);
  expect(decisionsNow(later(HOUR))[0]?.send).toMatchObject({
    eventId: "$event1",
  });
});

test("nothing is sent for another option, his words added, the command line, a lapse, or a card asked before Life could send", async () => {
  const deliver = () => Promise.reject(new Error("must not send"));
  const wait = await draftCard();
  await answerDecision(wait.id, ["wait"], undefined, { deliver, now: NOW });
  const noted = await draftCard();
  await answerDecision(noted.id, ["send"], "say Saturday instead", {
    deliver,
    now: NOW,
  });
  const cli = await draftCard();
  await expect(
    answerDecision(cli.id, ["send"], undefined, { deliver, via: "cli" })
  ).rejects.toThrow("his own answer");
  const lapsed = await draftCard();
  expect(stateOf(lapsed.id, later(3 * DAY))).toBe("lapsed");
  // A card stored without a resolved chat (asked before Life could send).
  appendFileSync(
    DECISIONS,
    `${JSON.stringify({
      ...ask({
        draft,
        options: [
          { id: "send", label: "Send", outgoing: true },
          { id: "wait", label: "Wait" },
        ],
      }),
      asker: "planner",
      at: NOW.toISOString(),
      id: "dec_00000000000b",
      kind: "asked",
      schemaVersion: 3,
    })}\n`
  );
  await answerDecision("dec_00000000000b", ["send"], undefined, {
    deliver,
    now: NOW,
  });
  expect(decisionsNow(later(DAY)).filter((d) => d.send)).toEqual([]);
});

test("a failed send is recorded, never retried; the asker hears of an answer that sends only once its outcome is in", async () => {
  const { id } = await draftCard();
  const answered = later(HOUR);
  setSystemTime(answered);
  let release = (_: string) => undefined as unknown;
  const pending = answerDecision(id, ["send"], undefined, {
    deliver: () => new Promise((resolve) => (release = resolve)),
    now: answered,
  });
  // While the send runs, his answer is not yet settled for its asker.
  expect(settledBetween(decisionsNow(answered), NOW, later(DAY))).toEqual([]);
  release("$event2");
  await pending;
  expect(settledBetween(decisionsNow(), NOW, later(DAY))).toMatchObject([
    { id, send: { eventId: "$event2" } },
  ]);
  const failed = await draftCard();
  await answerDecision(failed.id, ["send"], undefined, {
    deliver: () => Promise.reject(new Error("not sent: room not joined")),
    now: answered,
  });
  expect(decisionsNow().find((d) => d.id === failed.id)?.send).toMatchObject({
    error: "not sent: room not joined",
    kind: "send-failed",
  });
});

test("a send that never ended (a crash) is told as such two minutes after his answer", async () => {
  const { id } = await draftCard();
  appendFileSync(
    DECISIONS,
    `${JSON.stringify({ at: later(HOUR).toISOString(), id, kind: "answered", options: ["send"], schemaVersion: 3, via: "connector" })}\n`
  );
  expect(decisionsNow(later(HOUR + 60_000))[0]?.send).toBeUndefined();
  const [d] = decisionsNow(later(HOUR + 2 * 60_000));
  expect(d?.send).toMatchObject({
    error: expect.stringContaining("never ended"),
  });
  expect(
    settledBetween(decisionsNow(later(2 * HOUR)), NOW, later(2 * HOUR))
  ).toHaveLength(1);
});

test("a request is checked: deadline 1 hour to 14 days ahead, options its ids, a step only of an open matter", async () => {
  const refused = (over: object) =>
    expect(requestDecision("planner", ask(over), NOW)).rejects.toThrow(
      "Not done"
    );
  await refused({ deadline: later(30 * 60_000).toISOString() });
  await refused({ deadline: later(15 * DAY).toISOString() });
  await refused({ onSilence: "maybe" });
  await refused({ options: [{ id: "yes", label: "Yes" }] });
  await refused({ subject: "obs_000000000001" });
  await requestDecision("planner", ask({ subject: "project:boiler" }), NOW);
  await requestDecision("planner", ask({ onSilence: null }), NOW);
  expect(decisionsNow(NOW)).toHaveLength(2);
});

test("a deadline with an offset is stored in UTC, so deadlines sort as strings", async () => {
  await requestDecision(
    "planner",
    ask({ deadline: "2026-11-19T16:00:00.000+07:00" }),
    NOW
  );
  expect(decisionsNow(NOW)[0]?.deadline).toBe("2026-11-19T09:00:00.000Z");
});

test("earlier versions' lines in the file are skipped: the old decisions page's, the cards before titles", async () => {
  mkdirSync(dirname(DECISIONS), { recursive: true });
  appendFileSync(
    DECISIONS,
    `${JSON.stringify({ at: NOW.toISOString(), data: {}, decision: "daily-1", schemaVersion: 1, step: "asked" })}\n${JSON.stringify({ ...ask(), asker: "planner", at: NOW.toISOString(), id: "dec_00000000000a", kind: "asked", recommended: ["yes"], schemaVersion: 2, why: "Cheapest." })}\n`
  );
  const { id } = await requestDecision("planner", ask(), NOW);
  expect(decisionsNow(NOW).map((d) => d.id)).toEqual([id]);
});

test("a decision is pushed once, as its deadline comes within 24 hours, or at once when it already has", async () => {
  await requestDecision("planner", ask(), NOW);
  await requestDecision(
    "planner",
    ask({ deadline: later(3 * HOUR).toISOString() }),
    NOW
  );
  const ids = decisionsNow(NOW).map((d) => d.id);
  const due = (from: Date, to: Date) =>
    pushDueOf(decisionsNow(to), from, to).map((d) => d.id);
  expect(due(later(-60_000), NOW)).toEqual(ids.slice(1));
  expect(due(NOW, later(DAY - 60_000))).toEqual([]);
  expect(due(later(DAY - 60_000), later(DAY))).toEqual(ids.slice(0, 1));
  expect(due(later(DAY), later(DAY + 60_000))).toEqual([]);
});

test("settled in a half-open window: an answer at a window's end comes in the next, once", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  await answerDecision(id, ["yes"], undefined, { now: later(HOUR) });
  const all = decisionsNow(later(2 * HOUR));
  expect(settledBetween(all, NOW, later(HOUR))).toEqual([]);
  expect(settledBetween(all, later(HOUR), later(2 * HOUR))).toMatchObject([
    { id, state: "answered" },
  ]);
});
