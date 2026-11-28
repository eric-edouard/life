import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { HOUR, MIN } from "../core/clock";
import { appendJsonl } from "../core/files";
import type { SourceEvent } from "../records/source";
import { withdrawAnswer } from "./decision-after-answer";
import { DECISIONS, DECISIONS_VERSION, Line } from "./decision-lines";
import {
  actOutcomeOf,
  answerDecision,
  decisionsNow,
  requestDecision,
  withdrawDraftsAnsweredInChat,
} from "./decisions";
import type { StoredDraft } from "./draft";
import { isChatTwiceOf } from "./draft-contest";
import type { sendDraft } from "./draft-send";

// A batch (the owner's decision of 28 Nov 2026): one card, several drafts, each into its own chat, all sent by his one
// pick, each through the one send with its own checks. Asking one is refused until his app shows every draft, so these
// cards are written as their `asked` line, as `requestDecision` will once the gate lifts.

const NOW = new Date("2026-11-18T09:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const ID = "dec_0000000000b1";
const draftTo = (chat: string, to: string): StoredDraft => ({
  channel: "whatsapp",
  chat,
  text: `Party on Saturday, ${to}?`,
  to,
});
const DRAFTS = [
  draftTo("111@s.whatsapp.net", "Ana"),
  draftTo("222@s.whatsapp.net", "Ben"),
];

/** A batch card into Ana's and Ben's chats, asked at `NOW`. */
const askBatch = () =>
  appendJsonl(DECISIONS, Line, [
    {
      asker: "planner",
      at: NOW.toISOString(),
      context: "",
      deadline: later(2 * 24 * HOUR).toISOString(),
      drafts: DRAFTS,
      id: ID,
      kind: "asked",
      links: [],
      onSilence: null,
      options: [
        { id: "send", label: "Send all", outgoing: true },
        { id: "no", label: "Not now" },
      ],
      question: "Send the two invites?",
      schemaVersion: DECISIONS_VERSION,
      title: "Invite to the party",
    },
  ]);

/** A send that answers each chat in turn: `outcomes[chat]` is its message's id, or the error it throws. */
const deliverer = (outcomes: Record<string, string | Error>) => {
  const sent: [string | undefined, string][] = [];
  const deliver: typeof sendDraft = (d, txn) => {
    sent.push([d.chat, txn]);
    const o = outcomes[d.chat ?? ""];
    return o instanceof Error ? Promise.reject(o) : Promise.resolve(o ?? "$x");
  };
  return { deliver, sent };
};
const sendAll = (deliver: typeof sendDraft, at = later(HOUR)) =>
  answerDecision(ID, ["send"], undefined, {
    deliver,
    now: at,
    via: "connector",
  });
const read = (at = later(HOUR)) => decisionsNow(at).find((d) => d.id === ID);

beforeEach(() => rmSync(DECISIONS, { force: true }));
afterEach(() => setSystemTime());

test("asking a batch is refused until his app shows every draft", async () => {
  await expect(
    requestDecision(
      "planner",
      {
        context: "",
        deadline: later(2 * 24 * HOUR).toISOString(),
        drafts: DRAFTS,
        options: [
          { id: "send", label: "Send all", outgoing: true },
          { id: "no", label: "Not now" },
        ],
        question: "Send the two invites?",
        title: "Invite to the party",
      },
      NOW
    )
  ).rejects.toThrow("`drafts`, a batch");
});

test("his one Send sends every draft in order, each once under its own id, one line each; a second answer sends nothing", async () => {
  askBatch();
  expect(read(NOW)?.drafts).toEqual(DRAFTS);
  const { deliver, sent } = deliverer({
    "111@s.whatsapp.net": "$a",
    "222@s.whatsapp.net": "$b",
  });
  await sendAll(deliver);
  expect(sent).toEqual([
    ["111@s.whatsapp.net", ID],
    ["222@s.whatsapp.net", `${ID}.1`],
  ]);
  const d = read();
  expect(d?.state).toBe("answered");
  expect(d?.sends).toMatchObject([
    { eventId: "$a", kind: "sent" },
    { draftIndex: 1, eventId: "$b", kind: "sent" },
  ]);
  expect(d && actOutcomeOf(d, "send")).toMatchObject({ eventId: "$b" });
  await expect(sendAll(deliver)).rejects.toThrow("answered");
  expect(sent).toHaveLength(2);
});

test("a draft refused on its own check goes nowhere while the others go; once any went the card stays answered and nothing goes twice", async () => {
  askBatch();
  const { deliver, sent } = deliverer({
    "111@s.whatsapp.net": new Error(
      "not sent: someone wrote in Ana since this card was asked"
    ),
    "222@s.whatsapp.net": "$b",
  });
  await sendAll(deliver);
  expect(sent).toHaveLength(2);
  const d = read();
  expect(d?.state).toBe("answered");
  expect(d?.sends.map((s) => s.kind)).toEqual(["send-failed", "sent"]);
  await expect(sendAll(deliver, later(2 * HOUR))).rejects.toThrow("answered");
  expect(sent).toHaveLength(2);
});

test("when nothing of the batch went, his answer is voided and the card open again; his next Send tries every draft again", async () => {
  askBatch();
  const off = new Error("not sent: WhatsApp is off");
  const first = deliverer({
    "111@s.whatsapp.net": off,
    "222@s.whatsapp.net": off,
  });
  await sendAll(first.deliver);
  expect(read()?.state).toBe("open");
  // The first draft's line: "someone wrote since" counts from the earliest attempt.
  expect(read()?.notSent).toMatchObject({ error: "not sent: WhatsApp is off" });
  expect(read()?.notSent).not.toHaveProperty("draftIndex");
  const second = deliverer({});
  await sendAll(second.deliver, later(2 * HOUR));
  expect(second.sent.map(([chat]) => chat)).toEqual(DRAFTS.map((d) => d.chat));
  expect(read(later(2 * HOUR))?.state).toBe("answered");
});

test("a batch send that never ended reads as may have gone for each draft with no line: never open again", async () => {
  askBatch();
  // Ben's send hangs (the process died with it): only Ana's line is in.
  const deliver: typeof sendDraft = (x) =>
    x.chat === "111@s.whatsapp.net"
      ? Promise.resolve("$a")
      : new Promise<string>(() => undefined);
  sendAll(deliver);
  await Bun.sleep(0);
  expect(read()?.sends).toHaveLength(1);
  const d = read(later(5 * HOUR));
  expect(d?.state).toBe("answered");
  expect(d?.sends).toMatchObject([
    { kind: "sent" },
    {
      draftIndex: 1,
      error: expect.stringContaining("may have gone"),
      kind: "send-failed",
    },
  ]);
});

test("chats are held per chat: a batch never waits on a card holding one of its chats, a one-draft card into one of a batch's chats waits on it, and his message in any of them withdraws the batch", async () => {
  askBatch();
  const ben = () => Promise.resolve(draftTo("222@s.whatsapp.net", "Ben"));
  const card = {
    context: "Ben offered to bake for the party.",
    deadline: later(2 * 24 * HOUR).toISOString(),
    draft: { channel: "whatsapp", text: "Bring a cake?", to: "Ben" },
    options: [
      { id: "send", label: "Send it", outgoing: true },
      { id: "no", label: "Not now" },
    ],
    question: "Ask Ben for a cake?",
    title: "A cake for the party",
  };
  const asked = await requestDecision("other", card, later(MIN), ben);
  expect(asked.waits?.on).toBe(ID);
  // He wrote in Ben's chat himself: the whole batch is withdrawn, once.
  const wrote = (cards: { draft: Pick<StoredDraft, "chat"> }[]) =>
    cards.map((c) =>
      c.draft.chat === "222@s.whatsapp.net"
        ? [{ at: later(2 * MIN).toISOString(), fromMe: true } as SourceEvent]
        : []
    );
  expect(withdrawDraftsAnsweredInChat(later(3 * MIN), wrote)).toEqual([ID]);
  expect(read(later(3 * MIN))?.state).toBe("withdrawn");
});

test("a first draft not sent while the next still runs leaves the card answered and its chats held: a second Send is refused", async () => {
  askBatch();
  const deliver: typeof sendDraft = (x) =>
    x.chat === "111@s.whatsapp.net"
      ? Promise.reject(new Error("not sent: WhatsApp is off"))
      : new Promise<string>(() => undefined);
  sendAll(deliver);
  await Bun.sleep(0);
  expect(read()?.state).toBe("answered");
  await expect(sendAll(deliver)).rejects.toThrow("answered");
  // A card into Ana's chat waits while the batch's send runs.
  const ana = () => Promise.resolve(draftTo("111@s.whatsapp.net", "Ana"));
  const asked = await requestDecision(
    "other",
    {
      context: "Ana asked about the time.",
      deadline: later(2 * 24 * HOUR).toISOString(),
      draft: { channel: "whatsapp", text: "It starts at 8.", to: "Ana" },
      options: [
        { id: "send", label: "Send it", outgoing: true },
        { id: "no", label: "Not now" },
      ],
      question: "Tell Ana the time?",
      title: "The party's time",
    },
    later(HOUR),
    ana
  );
  expect(asked.waits?.on).toBe(ID);
});

test("a batch that sent is never undone", async () => {
  askBatch();
  await sendAll(deliverer({}).deliver);
  expect(() => withdrawAnswer(ID, "$x")).toThrow("only deleting");
});

test("two drafts of one card into one chat are refused: the first sent would refuse the second", () => {
  expect(isChatTwiceOf(DRAFTS)).toBe(false);
  expect(isChatTwiceOf([...DRAFTS, draftTo("111@s.whatsapp.net", "Ana")])).toBe(
    true
  );
  expect(isChatTwiceOf([{ channel: "mail" }, { channel: "mail" }])).toBe(false);
});
