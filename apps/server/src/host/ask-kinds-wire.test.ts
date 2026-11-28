import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import { setSettings } from "../core/settings";
import { decisionCardOf } from "../memory/checks";
import { DECISIONS } from "../memory/decision-lines";
import { decisionsNow, requestDecision } from "../memory/decisions";
import { NEED_KINDS, type Need, needsShownOf } from "../memory/needs";
import { BLOCKS, parseBlock } from "../records/answer-blocks";
import {
  MAIN_SESSION_ACT_KINDS,
  MAIN_SESSION_LINE_KINDS,
  type MainSessionLine,
} from "../records/main-session-wire";
import { expectWire } from "./http/wire-fixture";

// One made-up occurrence of each kind the phone is sent, for the phone's coverage test (`scripts/ask-coverage.test.ts`):
// the needs a card holds, Life's answer blocks, and the card parts beyond its question. Written by the server's own code.

beforeEach(() => {
  rmSync(DECISIONS, { force: true });
  setSettings({
    appointmentsCalendar: { account: "me@example.com", calendar: "Life" },
  });
});
afterEach(() => {
  rmSync(DECISIONS, { force: true });
  setSettings({ appointmentsCalendar: null });
});

const NEEDS: Record<(typeof NEED_KINDS)[number], Need> = {
  account: {
    bank: "Kasikornbank",
    holder: "Blue Reef Diving Co., Ltd.",
    kind: "account",
    number: "012-3-45678-9",
    scheme: "th_account",
  },
  amount: { currency: "THB", kind: "amount", value: 4500 },
  apify: {
    actor: "made/up-actor",
    estimateUsd: 0.1,
    input: { query: "clinics" },
    kind: "apify",
    maxUsd: 0.5,
    what: "20 clinics",
  },
  app: { kind: "app", name: "Grab", url: "https://grab.example.com/open" },
  event: {
    end: "2026-12-01T12:00:00+07:00",
    kind: "event",
    reminders: [60],
    start: "2026-12-01T08:00:00+07:00",
    title: "Dive course",
  },
  link: {
    kind: "link",
    url: "https://pay.example.com/i/123",
    vendor: "Fibrenet",
  },
  place: { kind: "place", name: "Chatuchak vehicle office" },
  qr: { kind: "qr", payload: "00020101", source: "Kit's WhatsApp of 20 Nov" },
  text: { copy: true, kind: "text", label: "Reference", text: "INV-2041" },
};

test("every kind of need, as a card shows it", () => {
  expect(Object.keys(NEEDS).toSorted()).toEqual(NEED_KINDS.toSorted());
  expectWire("ask_needs", needsShownOf(NEED_KINDS.map((k) => NEEDS[k])));
});

const BODIES: Record<keyof typeof BLOCKS, unknown> = {
  document: {
    from: "life:msg:whatsapp|1",
    kind: "receipt",
    lines: ["2 coffees", "90 THB"],
    title: "Cafe receipt",
    total: 90,
  },
  items: ["life:dec_000000000001"],
  phrase: { lang: "th", mine: "Thank you", text: "ขอบคุณ" },
  pictures: ["life:file:1"],
  place: { address: "1 Made Up Road", name: "Made Up Clinic" },
  question: { answers: ["Yes", "No"], recommended: "Yes" },
  settings: {
    keys: ["quiet"],
    offer: { key: "quiet", label: "Keep Kit quiet until Monday?" },
  },
  table: {
    columns: ["Day", "THB"],
    from: "life:msg:whatsapp|2",
    rows: [["Mon", 10]],
    total: 10,
  },
};

test("every kind of answer block, as the server checks it", () => {
  const checked = Object.fromEntries(
    Object.entries(BODIES).map(([kind, body]) => {
      const block = parseBlock({ json: JSON.stringify(body), kind });
      expect("error" in block).toBe(false);
      return [kind, block];
    })
  );
  expect(Object.keys(checked).toSorted()).toEqual(
    Object.keys(BLOCKS).toSorted()
  );
  expectWire("ask_blocks", checked);
});

const OPTION = { id: "do", label: "Do it" };
const draft = { channel: "whatsapp", text: "Can you come Friday?", to: "Kit" };
const read = () =>
  Promise.resolve({ ...draft, chat: "155@s.whatsapp.net", to: "Kit Moreau" });
const ask = (title: string, more: object) =>
  requestDecision(
    "planner",
    {
      ask: "Pick one",
      context: "A made-up reason to ask.",
      deadline: new Date(Date.now() + 2 * DAY).toISOString(),
      follow: ["Book the earliest"],
      onSilence: null,
      question: "Do it?",
      recommended: "do",
      title,
      ...more,
    } as never,
    undefined,
    read
  );

test("the card parts beyond its question: quick edits, next asks, what changed, and each option's flag", async () => {
  const ids = [
    await ask("Edit by tap", {
      changed: ["edit:tap"],
      draft,
      edits: ["More concise", "Warmer"],
      options: [
        { ...OPTION, outgoing: true },
        { id: "no", label: "No" },
      ],
    }),
    await ask("Edit by words", {
      changed: ["edit:words", "message"],
      draft,
      edits: ["Warmer"],
      options: [
        { ...OPTION, outgoing: true },
        { id: "no", label: "No" },
      ],
    }),
    await ask("I've paid", {
      doneSeenBy: "payment",
      needs: [NEEDS.account, NEEDS.amount],
      options: [
        { ...OPTION, looks: true },
        { id: "no", label: "No" },
      ],
    }),
    await ask("Dive", {
      needs: [NEEDS.event],
      options: [
        { ...OPTION, adds: true },
        { id: "no", label: "No" },
      ],
    }),
    await ask("Run", {
      needs: [NEEDS.apify],
      options: [
        { ...OPTION, runs: true },
        { id: "no", label: "No" },
      ],
    }),
  ];
  expect(decisionsNow().length).toBe(ids.length);
  // Each as the inbox holds it (the shape `read_thread` gives an open ask's `card`).
  expectWire(
    "ask_card_parts",
    decisionsNow().map((d) => ({
      about: [],
      agent: null,
      asker: d.asker,
      at: d.at,
      clips: [],
      context: d.context || null,
      deadline: d.deadline,
      draft: d.drafts[0] ?? null,
      group: "decision",
      isPlan: false,
      kind: "decision",
      likelyPeople: [],
      links: [],
      onMatters: [],
      onSilence: d.onSilence,
      ...decisionCardOf(d),
      pushId: `push-${d.id}`,
      question: d.question,
      ref: d.id,
      title: d.title,
      urgency: "blocks",
    })),
    true
  );
});

test("every kind of line the main session streams, and the acts its answer reports", () => {
  const lines = [
    { kind: "thinking" },
    { kind: "step", verb: "Opening", what: "the matter" },
    { kind: "words", text: "Done. " },
    { block: BODIES.question, kind: "block", type: "question" },
    { kind: "reaction", with: "👀" },
    {
      answer: {
        acts: [
          { kind: "done", matter: "mat_000000000001" },
          { agent: "Planner", kind: "agent", told: "Ask Kit about Friday" },
          { card: "dec_000000000001", kind: "card" },
          { kind: "fix" },
        ],
        entry: 1,
        kind: "reply",
        reaction: "👍",
        refs: ["life:dec_000000000001"],
        text: "Done.",
      },
      kind: "answer",
    },
  ] satisfies MainSessionLine[];
  expect(lines.map((l) => l.kind).toSorted()).toEqual([
    ...MAIN_SESSION_LINE_KINDS,
  ]);
  const answer = lines.at(-1) as Extract<MainSessionLine, { kind: "answer" }>;
  expect(
    (answer.answer.kind === "reply" ? answer.answer.acts : [])
      .map((a) => a.kind)
      .toSorted()
  ).toEqual([...MAIN_SESSION_ACT_KINDS]);
  expectWire("ask_main_session", lines);
});
