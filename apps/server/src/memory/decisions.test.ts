import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DAY, HOUR, MIN } from "../core/clock";
import type { SourceEvent } from "../records/source";
import type { Descriptor } from "../sources/contract";
import {
  answerDecision,
  DECISIONS,
  type Decision,
  decisionsNow,
  notSentOf,
  requestDecision,
  settledBetween,
  withdrawDraftsAnsweredInChat,
} from "./decisions";
import type { StoredDraft } from "./draft";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as draftSend from "./draft-send";

/** A chat that takes everything besides text. */
const ALL = { file: true, mentions: true, reaction: true, reply: true };

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
    ...draft,
    chat: "155@s.whatsapp.net",
    to: "Kit Moreau",
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
  await refused({ question: "Book Kit to fix the boiler" }, "end in a ?");
  await refused(
    {
      options: [
        { id: "yes", label: "Book Kit" },
        { id: "wait", label: "Wait for a second quote from him" },
      ],
    },
    "five words"
  );
  await refused({ draft: { text: "Can you come Friday?" } }, "to");
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
  const sent: unknown[][] = [];
  const deliver = (...a: [StoredDraft, string]) => {
    sent.push(a);
    return Promise.resolve("$event1");
  };
  const { id } = await draftCard();
  const done = await answerDecision(id, ["send"], undefined, {
    deliver,
    now: later(HOUR),
    via: "connector",
  });
  expect(sent).toEqual([
    [
      { ...draft, chat: "155@s.whatsapp.net", to: "Kit Moreau" },
      id,
      { onStep: undefined, since: NOW },
    ],
  ]);
  expect(done.at(-1)).toMatchObject({ eventId: "$event1", kind: "sent" });
  await expect(
    answerDecision(id, ["send"], undefined, {
      deliver,
      now: later(HOUR),
      via: "connector",
    })
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
    via: "connector",
  });
  const cli = await draftCard();
  await expect(
    answerDecision(cli.id, ["send"], undefined, { deliver, now: NOW })
  ).rejects.toThrow("his own answer");
  // One open draft per chat: the next card waits for this one's answer.
  await answerDecision(cli.id, ["wait"], undefined, { deliver, now: NOW });
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
    via: "connector",
  });
  expect(decisionsNow(later(DAY)).filter((d) => d.send)).toEqual([]);
});

test("a failed send is recorded, never retried; the asker hears of an answer that sends only once its outcome is in", async () => {
  const { id } = await draftCard();
  const answered = later(HOUR);
  setSystemTime(answered);
  let release = (_: string) => undefined as unknown;
  const pending = answerDecision(id, ["send"], undefined, {
    deliver: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    now: answered,
    via: "connector",
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
    deliver: () => Promise.reject(new Error("may have gone: no answer")),
    now: answered,
    via: "connector",
  });
  expect(decisionsNow().find((d) => d.id === failed.id)?.send).toMatchObject({
    error: "may have gone: no answer",
    kind: "send-failed",
  });
});

const notSent =
  (why = "room not joined") =>
  () =>
    Promise.reject(new Error(`not sent: ${why}`));

test("a not-sent outcome voids its answer: the card is open again, only his next answer sends, once; may have gone stays answered", async () => {
  const { id } = await draftCard();
  const at = later(HOUR);
  const first = await answerDecision(id, ["send"], undefined, {
    answerKey: "tap-1",
    deliver: notSent(),
    now: at,
    via: "connector",
  });
  expect(first.at(-1)).toMatchObject({ kind: "send-failed" });
  const [open] = decisionsNow(later(2 * HOUR));
  expect(open).toMatchObject({
    notSent: { error: "not sent: room not joined" },
    state: "open",
    voided: [{ answer: { answerKey: "tap-1" } }],
  });
  expect(open?.answer).toBeUndefined();
  expect(open?.send).toBeUndefined();
  // Nothing settled for its asker yet.
  expect(
    settledBetween(decisionsNow(later(2 * HOUR)), NOW, later(DAY))
  ).toEqual([]);
  const sent: unknown[] = [];
  const deliver = (...a: unknown[]) => {
    sent.push(a);
    return Promise.resolve("$ev9");
  };
  // Two answers at once after the not-sent: one sends.
  const both = await Promise.allSettled(
    [0, 1].map(() =>
      answerDecision(id, ["send"], undefined, {
        deliver,
        now: later(2 * HOUR),
        via: "connector",
      })
    )
  );
  expect(both.map((r) => r.status).toSorted()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(sent).toHaveLength(1);
  expect(decisionsNow(later(2 * HOUR))[0]).toMatchObject({
    send: { eventId: "$ev9" },
    state: "answered",
  });
  // The send's own words: since his last attempt that went nowhere.
  expect(sent[0]).toMatchObject([
    expect.anything(),
    id,
    { since: new Date(open?.notSent?.at ?? "") },
  ]);
  const gone = await draftCard();
  await answerDecision(gone.id, ["send"], undefined, {
    deliver: () => Promise.reject(new Error("may have gone: x")),
    now: at,
    via: "connector",
  });
  await expect(
    answerDecision(gone.id, ["send"], undefined, {
      deliver,
      now: at,
      via: "connector",
    })
  ).rejects.toThrow("answered");
});

test("a not-sent that found a message carries it to the card: wrote, else null", async () => {
  const { id } = await requestDecision(
    "planner",
    ask({
      draft,
      options: [
        { id: "send", label: "Send it", outgoing: true },
        { id: "wait", label: "Wait" },
      ],
    }),
    NOW,
    readChat
  );
  const wrote = { at: later(1).toISOString(), by: "Ana", text: "wait" };
  await answerDecision(id, ["send"], undefined, {
    deliver: () =>
      Promise.reject(
        Object.assign(new Error("not sent: someone wrote in Ana"), { wrote })
      ),
    now: later(2),
    via: "connector",
  });
  const [d] = decisionsNow(later(3));
  expect(notSentOf(d as Decision)).toMatchObject({ wrote });
  expect(
    notSentOf({
      ...(d as Decision),
      notSent: { ...d?.notSent, wrote: undefined } as never,
    })?.wrote
  ).toBeNull();
});

test("a lapse whose answer a late not-sent voided settles when it was voided, so a poll past the deadline sees it; never retryable is kept", async () => {
  const { id } = await requestDecision(
    "planner",
    ask({
      deadline: later(HOUR + 30_000).toISOString(),
      draft,
      options: [
        { id: "send", label: "Send it", outgoing: true },
        { id: "wait", label: "Wait" },
      ],
    }),
    NOW,
    readChat
  );
  const gone = Object.assign(new Error("not sent: the file is gone"), {
    canRetry: false,
  });
  setSystemTime(later(HOUR + 60_000));
  await answerDecision(id, ["send"], undefined, {
    deliver: () => Promise.reject(gone),
    now: later(HOUR),
    via: "connector",
  });
  const [d] = decisionsNow(later(HOUR + 60_000));
  expect(d).toMatchObject({ notSent: { canRetry: false }, state: "lapsed" });
  expect(
    settledBetween(
      decisionsNow(later(2 * HOUR)),
      later(HOUR + 45_000),
      later(2 * HOUR)
    )
  ).toHaveLength(1);
});

test("an answer's key is kept on its line", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  await answerDecision(id, ["yes"], undefined, {
    answerKey: "tap-7",
    now: NOW,
  });
  expect(decisionsNow(NOW)[0]?.answer?.answerKey).toBe("tap-7");
});

// 19 Nov 2026 (review A, B1): a fixed 5 minutes declared a slow mail "may have gone" while gog still sent it.
test("a send that never ended (a crash) is told as such a minute past its path's own limit, however long that is", async () => {
  const limit = spyOn(draftSend, "sendLimitMs").mockReturnValue(5 * MIN);
  const { id } = await draftCard();
  appendFileSync(
    DECISIONS,
    `${JSON.stringify({ at: later(HOUR).toISOString(), id, kind: "answered", options: ["send"], schemaVersion: 3, via: "connector" })}\n`
  );
  expect(decisionsNow(later(HOUR + 5 * MIN))[0]?.send).toBeUndefined();
  expect(decisionsNow(later(HOUR + 6 * MIN - 1))[0]?.send).toBeUndefined();
  const [d] = decisionsNow(later(HOUR + 6 * MIN));
  limit.mockRestore();
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

test("a matter's id as the subject rides on its newest step", async () => {
  const book = spyOn(
    await import("./matters"),
    "readMatterBook"
  ).mockResolvedValue([
    {
      id: "matter_aaaaaaaaaaaa",
      open: true,
      steps: [{ ref: "obs_000000000001" }, { ref: "obs_000000000002" }],
    },
  ] as never);
  try {
    await requestDecision(
      "planner",
      ask({ subject: "matter_aaaaaaaaaaaa" }),
      NOW
    );
    await expect(
      requestDecision("planner", ask({ subject: "matter_bbbbbbbbbbbb" }), NOW)
    ).rejects.toThrow("no open matter is or holds");
    expect(decisionsNow(NOW)[0]?.subject).toBe("obs_000000000002");
  } finally {
    book.mockRestore();
  }
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

test("settled in a half-open window: an answer at a window's end comes in the next, once", async () => {
  const { id } = await requestDecision("planner", ask(), NOW);
  await answerDecision(id, ["yes"], undefined, { now: later(HOUR) });
  const all = decisionsNow(later(2 * HOUR));
  expect(settledBetween(all, NOW, later(HOUR))).toEqual([]);
  expect(settledBetween(all, later(HOUR), later(2 * HOUR))).toMatchObject([
    { id, state: "answered" },
  ]);
});

// 20 Nov 2026: "Done" on an agent's card ended nothing in Life; an option marked `ends` is his word that it is done.
const OPEN_MATTER = {
  id: "matter_aaaaaaaaaaaa",
  open: true,
  steps: [
    { kind: "episode", ref: "ep_000000000001" },
    { kind: "to_do", ref: "obs_000000000001" },
    {
      ending: { at: NOW.toISOString(), by: "record", why: "done" },
      kind: "promise",
      ref: "obs_000000000002",
    },
  ],
};
const DONE = { ends: "step", id: "done", label: "Done" };
const withMatter = async <T>(run: () => Promise<T>) => {
  const book = spyOn(
    await import("./matters"),
    "readMatterBook"
  ).mockResolvedValue([OPEN_MATTER] as never);
  try {
    return await run();
  } finally {
    book.mockRestore();
  }
};
const endsAsk = (over = {}) =>
  ask({
    onSilence: null,
    options: [DONE, { id: "later", label: "Not yet" }],
    subject: "obs_000000000001",
    ...over,
  });

test("an `ends` option is checked when asked: on an open step or matter, never outgoing, never on silence", async () => {
  const refused = (over: object, why: string) =>
    expect(
      withMatter(() => requestDecision("planner", endsAsk(over), NOW))
    ).rejects.toThrow(why);
  await refused({ subject: undefined }, "needs a `subject` on an open matter");
  await refused({ subject: "project:boiler" }, "on an open matter");
  await refused({ subject: "matter_aaaaaaaaaaaa" }, "not the matter's id");
  // A step already ended, or one that can't be open (an episode), is no step to close.
  await refused({ subject: "obs_000000000002" }, "open steps");
  await refused({ subject: "ep_000000000001" }, "open steps");
  await refused({ onSilence: "done" }, "never takes an `ends` option");
  await refused(
    {
      options: [
        { ...DONE, outgoing: true },
        { id: "no", label: "No" },
      ],
    },
    "never both"
  );
  const matter = { ...DONE, ends: "matter" };
  await withMatter(() =>
    requestDecision(
      "planner",
      endsAsk({
        options: [matter, { id: "no", label: "No" }],
        subject: "matter_aaaaaaaaaaaa",
      }),
      NOW
    )
  );
  await withMatter(() => requestDecision("planner", endsAsk(), NOW));
  expect(decisionsNow(NOW).map((d) => d.options[0]?.ends)).toEqual([
    "matter",
    "step",
  ]);
});

test("his pick of an `ends` option alone ends it once; with his words, another option or from a session, nothing ends", async () => {
  const ended: string[] = [];
  const end = (d: Omit<Decision, "state">) => {
    ended.push(d.id);
    return Promise.resolve();
  };
  const card = () =>
    withMatter(() => requestDecision("planner", endsAsk(), NOW));
  const first = await card();
  // A session (or the desk) has no `end`: refused, nothing written.
  await expect(
    answerDecision(first.id, ["done"], undefined, { now: later(HOUR) })
  ).rejects.toThrow("only on his own answer");
  const done = await answerDecision(first.id, ["done"], undefined, {
    end,
    now: later(HOUR),
    via: "connector",
  });
  expect(done).toMatchObject([
    { kind: "answered" },
    { id: first.id, kind: "ended" },
  ]);
  await expect(
    answerDecision(first.id, ["done"], undefined, {
      end,
      now: later(HOUR),
      via: "connector",
    })
  ).rejects.toThrow("answered");
  expect(ended).toEqual([first.id]);
  const second = await card();
  await answerDecision(second.id, ["done"], "Only half of it", {
    end,
    now: later(HOUR),
    via: "connector",
  });
  const third = await card();
  await answerDecision(third.id, ["done", "later"], undefined, {
    end,
    now: later(HOUR),
    via: "connector",
  });
  expect(ended).toEqual([first.id]);
  const byId = new Map(decisionsNow(later(2 * HOUR)).map((d) => [d.id, d]));
  expect(byId.get(first.id)?.end).toMatchObject({ kind: "ended" });
  expect(byId.get(second.id)?.end).toBeUndefined();
});

test("the asker hears of an end once its outcome is in: a failure carries its error; one that never ended is told so past its limit", async () => {
  const { id } = await withMatter(() =>
    requestDecision("planner", endsAsk(), NOW)
  );
  await answerDecision(id, ["done"], undefined, {
    end: () => Promise.reject(new Error("Not done: the list app is off.")),
    now: later(HOUR),
    via: "connector",
  });
  // The outcome is stamped at the real clock, after `now`: a window to the far future holds it.
  const ever = new Date("2100-01-01T00:00:00.000Z");
  expect(settledBetween(decisionsNow(later(DAY)), NOW, ever)).toEqual([
    expect.objectContaining({
      end: expect.objectContaining({ error: "Not done: the list app is off." }),
      id,
    }),
  ]);
  rmSync(DECISIONS, { force: true });
  const hung = await withMatter(() =>
    requestDecision("planner", endsAsk(), NOW)
  );
  const never = answerDecision(hung.id, ["done"], undefined, {
    end: () => new Promise(() => undefined),
    now: later(HOUR),
    via: "connector",
  });
  expect(never).toBeInstanceOf(Promise);
  await Bun.sleep(10);
  // Answered, its end still running: not settled yet; past its limit with no outcome, settled as never ended.
  expect(
    settledBetween(decisionsNow(later(HOUR + 10 * MIN)), NOW, later(DAY))
  ).toEqual([]);
  expect(
    decisionsNow(later(DAY)).find((d) => d.id === hung.id)?.end?.error
  ).toStartWith("may not have ended");
});

/** Kit's made-up WhatsApp chat holding `messages` (at minutes after the card, his own or Kit's), and a send path that sends. */
const kitChat = (messages: { fromMe: boolean; min: number }[]) => {
  const events = messages.map(
    ({ fromMe, min }): SourceEvent => ({
      at: later(min * MIN).toISOString(),
      chat: "155@s.whatsapp.net",
      chatName: "Kit Moreau",
      fromMe,
      id: `m${min}`,
      sender: fromMe ? "me" : "Kit Moreau",
      source: "whatsapp",
      text: "Friday is fine",
    })
  );
  return {
    kind: "chat",
    label: "WhatsApp",
    name: "whatsapp",
    read: () => events,
    send: {
      block: async () => undefined,
      holds: (chats) => chats,
      limitMs: () => 1000,
      refusal: async () => undefined,
      send: async () => "$sent",
      takes: () => ALL,
    },
    silentAfter: 0,
  } satisfies Descriptor as Descriptor;
};
/** The watcher's step over `chat` alone. */
const withdrawAt = (min: number, chat: Descriptor) =>
  withdrawDraftsAnsweredInChat(later(min * MIN), (cards) =>
    draftSend.wroteSince(cards, [chat])
  );

test("his own message in a draft's chat after the ask withdraws the card, by code; its asker hears it once", async () => {
  const { id } = await draftCard();
  const chat = kitChat([{ fromMe: true, min: 5 }]);
  expect(withdrawAt(6, chat)).toEqual([id]);
  const [d] = decisionsNow(later(6 * MIN));
  expect(d?.state).toBe("withdrawn");
  expect(d?.withdrawn).toMatchObject({
    answeredInChatAt: later(5 * MIN).toISOString(),
    at: later(6 * MIN).toISOString(),
    why: "he answered in the chat himself",
  });
  expect(withdrawAt(7, chat)).toEqual([]);
  // Settled when withdrawn, not at his message: a poll whose window passed 09:05 still hears it, once.
  const list = decisionsNow(later(DAY));
  expect(settledBetween(list, NOW, later(5 * MIN))).toEqual([]);
  expect(settledBetween(list, later(5 * MIN), later(DAY))).toMatchObject([
    { id },
  ]);
  await expect(
    answerDecision(id, ["send"], undefined, {
      now: later(8 * MIN),
      via: "connector",
    })
  ).rejects.toThrow("withdrawn");
});

test("someone else's message leaves the card open and his tap's send refused; his own before that refusal withdraws nothing", async () => {
  const { id } = await draftCard();
  const chat = kitChat([
    { fromMe: false, min: 3 },
    { fromMe: true, min: 4 },
  ]);
  // Kit's message alone withdraws nothing.
  expect(withdrawAt(5, kitChat([{ fromMe: false, min: 3 }]))).toEqual([]);
  expect(stateOf(id, later(5 * MIN))).toBe("open");
  setSystemTime(later(6 * MIN));
  const [, outcome] = await answerDecision(id, ["send"], undefined, {
    deliver: (d, txn, steps) => draftSend.sendDraft(d, txn, steps, [chat]),
    now: later(6 * MIN),
    via: "connector",
  });
  expect(outcome).toMatchObject({ kind: "send-failed" });
  expect(String((outcome as { error?: string }).error)).toContain(
    "someone wrote in"
  );
  // The card is open again, and "since" is his tap: his 09:04 message is older, so nothing is withdrawn.
  expect(withdrawAt(7, chat)).toEqual([]);
  expect(stateOf(id, later(7 * MIN))).toBe("open");
  expect(withdrawAt(9, kitChat([{ fromMe: true, min: 8 }]))).toEqual([id]);
});

test("a card with no draft is untouched, and a second draft into an open draft's chat is refused with that card's id", async () => {
  const plain = await requestDecision("planner", ask(), NOW);
  const { id } = await draftCard();
  await expect(
    requestDecision(
      "atlas",
      ask({
        draft,
        options: [
          { id: "send", label: "Send it", outgoing: true },
          { id: "wait", label: "Wait" },
        ],
      }),
      NOW,
      readChat
    )
  ).rejects.toThrow(`${id} already asks a draft into Kit Moreau`);
  // A card with no draft is still allowed beside it.
  await requestDecision("atlas", ask(), NOW);
  expect(withdrawAt(6, kitChat([{ fromMe: true, min: 5 }]))).toEqual([id]);
  expect(stateOf(plain.id, later(6 * MIN))).toBe("open");
  // Withdrawn, the chat takes a new draft.
  await expect(draftCard()).resolves.toMatchObject({ id: expect.any(String) });
});
