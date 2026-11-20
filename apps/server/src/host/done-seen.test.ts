import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import { DAY, iso } from "../core/clock";
import { setSettings } from "../core/settings";
import { CARD } from "../memory/card-request";
import type { InboxCheck } from "../memory/checks";
import {
  answerDecision,
  DECISIONS,
  decisionsNow,
  doneSeenByOf,
  requestDecision,
} from "../memory/decisions";
import { needsShownOf } from "../memory/needs";
import { openById } from "../memory/open-by-id";
import { localDate } from "../memory/zones";
import type { Payment } from "../payments/contract";
import { money } from "../payments/money";
import { answerWithResult } from "./answer-result";
import { lookForDone, lookForPaymentsDone, readSeenDone } from "./done-seen";
import { DECISION_ANSWERED, decisionCursorOf, pollDecisions } from "./events";
import { expectWire } from "./http/wire-fixture";

// A payment card (the asks contract, step 1): Life looks in his accounts for the amount on his "I've paid", and while
// the card is open. Made-up payees, accounts and payments throughout.

const NEEDS = [
  {
    bank: "Test Bank",
    holder: "Blue Reef Test Co.",
    kind: "account",
    number: "012-3-45678-9",
    scheme: "th_account",
  },
  { currency: "THB", kind: "amount", value: 4500 },
  { copy: true, kind: "text", label: "Reference", text: "DEP-12" },
];
const OPTIONS = [
  { id: "paid", label: "I've paid", looks: true },
  { id: "drop", label: "Drop it" },
];
const transfer = (over = {}) =>
  requestDecision("planner", {
    deadline: new Date(Date.now() + 2 * DAY).toISOString(),
    doneSeenBy: "payment",
    needs: NEEDS,
    onSilence: null,
    options: OPTIONS,
    question: "Pay the deposit by Monday?",
    title: "Pay the dive course deposit",
    ...over,
  });

/** A payment booked now, out unless `amount` is positive. */
const payment = (over: Partial<Payment> = {}): Payment => ({
  amount: -4500,
  category: "transfer",
  currency: "THB",
  date: localDate(iso(Date.now())),
  eur: -118.4,
  id: "p1",
  merchant: "Blue Reef Test Co.",
  note: null,
  paidAt: iso(Date.now()),
  spending: true,
  ...over,
});
let booked: Payment[] = [];
let reads: ReturnType<typeof spyOn>;
let listed: ReturnType<typeof spyOn>;

beforeEach(async () => {
  rmSync(DECISIONS, { force: true });
  setSettings({ payments: { backend: "money" } });
  booked = [];
  reads = spyOn(money, "between").mockImplementation(() =>
    Promise.resolve(booked)
  );
  listed = spyOn(
    await import("../memory/checks"),
    "checksNow"
  ).mockImplementation(async () =>
    decisionsNow()
      .filter((d) => d.state === "open")
      .map(
        (d) =>
          ({
            about: [],
            deadline: d.deadline,
            group: "decision",
            matter: null,
            pushId: "",
            ref: d.id,
          }) as unknown as InboxCheck
      )
  );
});
afterEach(() => {
  reads.mockRestore();
  listed.mockRestore();
  setSettings({ payments: null });
});
afterAll(() => rmSync(DECISIONS, { force: true }));

/** His answer through `answer_check`, with every step it reports. */
const answer = async (ref: string, options: string[], note?: string) => {
  const steps: Record<string, unknown>[] = [];
  const r = await answerWithResult(
    ref,
    { options, ...(note ? { note } : {}) },
    { answerKey: "tap-1", report: (s) => steps.push(s) }
  );
  return { r, steps };
};
/** What the asker's poll from `from` hears: past the half-open window's end, so a line written this instant is in. */
const eventsOf = async (from: Date) => {
  await Bun.sleep(5);
  return pollDecisions(DECISION_ANSWERED, decisionCursorOf(from), "planner")
    .events;
};

test("his I've paid finds the payment: Life looks, the card ends, the asker hears doneSeen", async () => {
  booked = [payment()];
  const from = new Date(Date.now() - 1000);
  const { id } = await transfer();
  const { r, steps } = await answer(id, ["paid"]);
  expectWire("answer_check_done_seen", r, true);
  expect(steps.map((s) => s.plan ?? s.step)).toEqual([
    ["recorded", "looking", "done_seen"],
    "recorded",
    "looking",
    "done_seen",
  ]);
  expect(steps.at(-1)).toMatchObject({ state: "seen" });
  expect(r).toMatchObject({
    changed: { options: ["paid"], state: "answered" },
    doneSeen: { state: "seen" },
  });
  expect((await eventsOf(from))[0]?.data).toMatchObject({
    answer: { options: ["paid"] },
    doneSeen: { eventId: "payments:p1", state: "seen" },
  });
});

test("not found: the card is open again saying so; the watcher's look later sees it, and the card ends with no answer of his", async () => {
  const from = new Date(Date.now() - 1000);
  const { id } = await transfer();
  const { r } = await answer(id, ["paid"]);
  expectWire("answer_check_not_found", r, true);
  expect(r).toMatchObject({
    asker: { told: "not_told" },
    changed: { state: "open" },
    doneSeen: { line: "Not in your accounts yet", state: "not_found" },
  });
  expect(await eventsOf(from)).toEqual([]);
  // The statement comes in: the watcher's look, at most every 5 minutes, one read for every open card.
  booked = [payment()];
  await lookForPaymentsDone(Date.now());
  await lookForPaymentsDone(Date.now() + 1000);
  expect(reads).toHaveBeenCalledTimes(2);
  expect(decisionsNow().find((d) => d.id === id)?.state).toBe("seen");
  const [told] = await eventsOf(from);
  expect(told?.eventId).toBe(`${id}.answered`);
  expect(told?.data).not.toHaveProperty("answer");
  expect(told?.data).toMatchObject({
    doneSeen: { eventId: "payments:p1", state: "seen" },
  });
});

test("only money out of exactly that amount in that currency, booked on or after the card's day, is its payment", async () => {
  const { id } = await transfer();
  const card = decisionsNow().find((d) => d.id === id);
  if (!card) {
    throw new Error("no card");
  }
  const yesterday = iso(Date.now() - DAY);
  booked = [
    payment({ currency: "EUR", eur: -4500, id: "euros" }),
    payment({ amount: 4500, eur: 118.4, id: "in" }),
    payment({ amount: -4500.5, id: "more" }),
    payment({ date: localDate(yesterday), id: "before", paidAt: yesterday }),
  ];
  expect(await readSeenDone([card])).toEqual(new Map());
  booked.push(payment({ amount: -4500.004, id: "exact" }));
  expect(await lookForDone(card)).toBe("payments:exact");
});

test("only a payment to the card's payee is its payment: by the bank's merchant, whole words, in the card's currency", async () => {
  const { id } = await transfer({
    needs: [{ ...NEEDS[0], holder: "Ms. Ann Lee" }, NEEDS[1]],
  });
  const card = decisionsNow().find((d) => d.id === id);
  if (!card) {
    throw new Error("no card");
  }
  booked = [
    payment({ id: "other", merchant: "MR. KIT SAMPLE" }),
    payment({ id: "generic", merchant: "Result of Funds Transfer (Success)" }),
    payment({ id: "longer", merchant: "Joanne Leeming" }),
    payment({ id: "initial", merchant: "B Lee" }),
    payment({ id: "note", merchant: "North Shop", note: "for Ann Lee" }),
    payment({ currency: "EUR", eur: -4500, id: "euros", merchant: "ANN LEE" }),
  ];
  expect(await readSeenDone([card])).toEqual(new Map());
  booked.push(payment({ id: "bank", merchant: "MS. LEE, ANN" }));
  expect(await lookForDone(card)).toBe("payments:bank");
  // The bank's whole line is read, past what a reader is shown (80 characters).
  booked = [
    payment({
      id: "long",
      merchant: `${"NORTHERN DISTRICT FRESH MARKET STALL ".repeat(3)}(A/C Name: MS. ANN LEE)`,
    }),
  ];
  expect(await lookForDone(card)).toBe("payments:long");
  // A EUR card is never seen by another currency's payment worth as much in EUR.
  const euro = await transfer({
    needs: [NEEDS[0], { currency: "EUR", kind: "amount", value: 118.4 }],
  });
  const euroCard = decisionsNow().find((d) => d.id === euro.id);
  booked = [
    payment({
      id: "baht",
      merchant: "BLUE REEF TEST (A/C Name: BLUE REEF TEST CO.,LTD.)",
    }),
  ];
  expect(euroCard && (await readSeenDone([euroCard]))).toEqual(new Map());
  // The bank's "A/C" lends no initial: its account name alone is compared.
  const initial = await transfer({
    needs: [{ ...NEEDS[0], holder: "A. Lee" }, NEEDS[1]],
  });
  const initialCard = decisionsNow().find((d) => d.id === initial.id);
  booked = [payment({ id: "label", merchant: "B LEE (A/C Name: B LEE)" })];
  expect(initialCard && (await readSeenDone([initialCard]))).toEqual(new Map());
  booked = [payment({ id: "theirs", merchant: "LEE SHOP (A/C Name: A LEE)" })];
  expect(initialCard && (await lookForDone(initialCard))).toBe(
    "payments:theirs"
  );
  // A card with no payee's name is refused when asked.
  await expect(
    transfer({ needs: [{ ...NEEDS[0], holder: "Co., Ltd." }, NEEDS[1]] })
  ).rejects.toThrow("needs the payee's name");
});

test("payments off: a tap card, its looks option a plain answer; his words added look for nothing; a session never looks", async () => {
  const off = await transfer();
  const on = await transfer();
  // His words with it: Tell the agent…, nothing looked for.
  await answer(on.id, ["paid"], "paid from the other account");
  expect(reads).not.toHaveBeenCalled();
  expect(decisionsNow().find((d) => d.id === on.id)?.state).toBe("answered");
  await expect(answerDecision(off.id, ["paid"])).rejects.toThrow(
    "Life looks for a step done only on his own answer"
  );
  setSettings({ payments: null });
  const card = decisionsNow().find((d) => d.id === off.id);
  expect(card && doneSeenByOf(card)).toBe("tap");
  await answerDecision(off.id, ["paid"]);
  expect(decisionsNow().find((d) => d.id === off.id)).toMatchObject({
    doneSeen: undefined,
    state: "answered",
  });
  expect(reads).not.toHaveBeenCalled();
});

test("a failed read is not found with its error; a look that never finished (a crash) reads as not found, the card open again", async () => {
  reads.mockImplementation(() => Promise.reject(new Error("money: timed out")));
  const failed = await transfer();
  const { r } = await answer(failed.id, ["paid"]);
  expect(r).toMatchObject({
    doneSeen: {
      line: "Life could not look in your accounts: money: timed out",
      state: "not_found",
    },
  });
  const crashed = await transfer();
  const at = new Date();
  appendFileSync(
    DECISIONS,
    `${JSON.stringify({ at: at.toISOString(), id: crashed.id, kind: "answered", options: ["paid"], schemaVersion: 3, via: "connector" })}\n`
  );
  expect(decisionsNow(at).find((d) => d.id === crashed.id)?.state).toBe(
    "answered"
  );
  const later = decisionsNow(new Date(at.getTime() + 2 * 60_000)).find(
    (d) => d.id === crashed.id
  );
  expect(later).toMatchObject({
    doneSeen: { error: "the look never finished", state: "not_found" },
    state: "open",
  });
});

test("a card's parts are checked when asked, each refusal pointing at its page; what is not built yet says so", async () => {
  await expect(transfer({ plan: [{ text: "Pay" }] })).rejects.toThrow(
    "`plan` is not built yet"
  );
  await expect(
    transfer({ options: [{ ...OPTIONS[0], takes: "file" }, OPTIONS[1]] })
  ).rejects.toThrow('`takes: "file"` (only `note`) is not built yet');
  await expect(transfer({ doneSeenBy: "visit" })).rejects.toThrow(
    "not built yet"
  );
  await expect(
    transfer({ needs: [{ currency: "baht", kind: "amount", value: 4500 }] })
  ).rejects.toThrow('Read fetch("ask/amount")');
  await expect(transfer({ needs: [{ kind: "iban" }] })).rejects.toThrow(
    "Expected 'account' | 'amount' | 'link' | 'text' | 'qr'"
  );
  await expect(
    transfer({ needs: [{ kind: "link", url: "shopapp://pay/1" }] })
  ).rejects.toThrow('Read fetch("ask/link")');
  await expect(transfer({ needs: [NEEDS[0]] })).rejects.toThrow(
    "needs one `amount` need"
  );
  await expect(transfer({ doneSeenBy: "tap" })).rejects.toThrow(
    'a `looks` option needs `doneSeenBy: "payment"`'
  );
  await expect(transfer({ onSilence: "paid" })).rejects.toThrow(
    "`onSilence` never takes a `looks` or `takes` option"
  );
  await expect(
    transfer({ options: [{ ...OPTIONS[0], outgoing: true }, OPTIONS[1]] })
  ).rejects.toThrow("has no other mark");
  // An option that takes his words takes them.
  const { id } = await transfer({
    options: [
      OPTIONS[0],
      { id: "other", label: "Paid another way", takes: "note" },
    ],
  });
  await expect(answerDecision(id, ["other"])).rejects.toThrow(
    "other takes his words"
  );
});

test("the card's rules are short and each part's are a fetch away", async () => {
  expect(CARD.length).toBeLessThan(1600);
  const page = await openById("ask/payment", undefined, undefined, () =>
    Promise.resolve("")
  );
  expect(page).toContain("`looks: true`");
  expect(
    await openById("ask/amount", undefined, undefined, () =>
      Promise.resolve("")
    )
  ).toContain('"currency":"THB"');
  expect(
    await openById("ask/plan", undefined, undefined, () => Promise.resolve(""))
  ).toContain("no page ask/plan: ask/draft, ask/options, ask/payment");
});

test("Life's line of each need, in the agent's order: what a phone that doesn't know the kind draws", async () => {
  const { id } = await transfer();
  const card = decisionsNow().find((d) => d.id === id);
  expect(needsShownOf(card?.needs).map((n) => n.line)).toEqual([
    "Test Bank 012-3-45678-9, Blue Reef Test Co.",
    "4,500 THB",
    "Reference: DEP-12",
  ]);
});

test("one payment settles one card: two open cards of the same amount, one payment, only one is seen", async () => {
  const a = await transfer();
  const b = await transfer();
  const cards = decisionsNow().filter((d) => [a.id, b.id].includes(d.id));
  booked = [payment()];
  expect([...(await readSeenDone(cards)).keys()]).toEqual([a.id]);
  await lookForPaymentsDone(Date.now() + 10 * 60_000);
  expect(decisionsNow().map((d) => d.state)).toEqual(["seen", "open"]);
  // The seen card's event is claimed: a later read gives it to no other card.
  expect(await readSeenDone([cards[1] as (typeof cards)[number]])).toEqual(
    new Map()
  );
});

test("his second answer after a look that never finished is the one kept, its result carries the answer", async () => {
  const { id } = await transfer();
  const at = new Date(Date.now() - 5 * 60_000);
  appendFileSync(
    DECISIONS,
    `${JSON.stringify({ at: at.toISOString(), id, kind: "answered", options: ["paid"], schemaVersion: 3, via: "connector" })}\n`
  );
  const { r } = await answer(id, ["paid"]);
  // Nothing booked: the new look finds nothing, but his second answer is the one the look belongs to.
  expect(r).toMatchObject({
    done: [{ kind: "answered" }, { kind: "done-seen", state: "not_found" }],
    doneSeen: { state: "not_found" },
  });
  expect(
    decisionsNow()
      .find((d) => d.id === id)
      ?.voided?.map((v) => v.answer.at)
  ).toEqual([at.toISOString(), expect.any(String)]);
});
