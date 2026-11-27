import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, HOUR, iso } from "../core/clock";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as deskRead from "../host/desk-read";
import { DECISIONS } from "../memory/decision-lines";
import { decisionsNow, requestDecision } from "../memory/decisions";
import { replyHourOf } from "../memory/exchange-counts";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as run from "../memory/run";
import { openDesk } from "./desk-store";
import {
  type GateReadings,
  gateCards,
  gateVerdictOf,
  nextBatchAtOf,
} from "./gate";

const now = new Date("2026-11-25T12:00:00.000Z");
const at = (hours: number) => iso(now.getTime() + hours * HOUR);
const fine: GateReadings = {
  canActNow: true,
  goodMoment: true,
  importance: "normal",
  sendBack: null,
  sensitive: false,
  urgency: "normal",
};
const verdict = (
  readings: Partial<GateReadings> | null,
  more: {
    batchAt?: number;
    deadline?: string;
    effect?: "interrupt" | "quiet";
    wasSentBack?: boolean;
  } = {}
) =>
  gateVerdictOf({
    deadline: more.deadline ?? at(48),
    now,
    readings: readings && { ...fine, ...readings },
    wasSentBack: more.wasSentBack ?? false,
    ...(more.batchAt === undefined ? {} : { batchAt: more.batchAt }),
    ...(more.effect ? { effect: more.effect } : {}),
  }).verdict;

test("a failed call lets the card through; a good moment delivers", () => {
  expect(verdict(null)).toBe("deliver");
  expect(verdict({})).toBe("deliver");
});

test("a send-back only once per piece of work; a sensitive card is sent back once, then delivered with no push", () => {
  expect(verdict({ sendBack: "Do the search yourself." })).toBe("send_back");
  expect(verdict({ sendBack: "Do it yourself." }, { wasSentBack: true })).toBe(
    "deliver"
  );
  expect(verdict({ sensitive: true })).toBe("send_back");
  expect(
    gateVerdictOf({
      deadline: at(48),
      now,
      readings: { ...fine, sensitive: true },
      wasSentBack: true,
    })
  ).toMatchObject({ silent: true, verdict: "deliver" });
});

test("not a good moment holds: 3 hours when urgency is normal, 12 when low; high urgency and interrupt pass", () => {
  expect(
    gateVerdictOf({
      deadline: at(48),
      now,
      readings: { ...fine, goodMoment: false },
      wasSentBack: false,
    })
  ).toMatchObject({ until: at(3), verdict: "hold" });
  expect(
    gateVerdictOf({
      deadline: at(48),
      now,
      readings: { ...fine, canActNow: false, urgency: "low" },
      wasSentBack: false,
    })
  ).toMatchObject({ until: at(12), verdict: "hold" });
  expect(verdict({ goodMoment: false, urgency: "high" })).toBe("deliver");
  expect(verdict({ goodMoment: false }, { effect: "interrupt" })).toBe(
    "deliver"
  );
});

test("never held past 12 hours (or the batch moment), nor into the 3 hours before its deadline; a hold that would end now delivers", () => {
  expect(
    gateVerdictOf({
      batchAt: now.getTime() + 20 * HOUR,
      deadline: at(48),
      now,
      readings: fine,
      wasSentBack: false,
    })
  ).toMatchObject({ until: at(20) });
  expect(
    gateVerdictOf({
      deadline: at(48),
      effect: "quiet",
      now,
      readings: fine,
      wasSentBack: false,
    })
  ).toMatchObject({ until: at(12) });
  expect(
    gateVerdictOf({
      deadline: at(5),
      now,
      readings: { ...fine, goodMoment: false },
      wasSentBack: false,
    })
  ).toMatchObject({ until: at(2) });
  expect(verdict({ goodMoment: false }, { deadline: at(2) })).toBe("deliver");
  expect(verdict({}, { effect: "quiet" })).toBe("hold");
});

test("a draft into a chat he answers in batches waits for his reply hour, within 12 hours; Life's app open is a free moment", () => {
  const facts = { deadline: at(48), now, wasSentBack: false };
  expect(
    gateVerdictOf({
      ...facts,
      readings: fine,
      replyAt: now.getTime() + 5 * HOUR,
    })
  ).toMatchObject({ rules: ["reply time"], until: at(5), verdict: "hold" });
  expect(
    gateVerdictOf({
      ...facts,
      readings: fine,
      replyAt: now.getTime() + 14 * HOUR,
    })
  ).toMatchObject({ verdict: "deliver" });
  expect(
    gateVerdictOf({
      ...facts,
      deadline: at(6),
      readings: fine,
      replyAt: now.getTime() + 5 * HOUR,
    })
  ).toMatchObject({ until: at(3) });
  expect(
    gateVerdictOf({
      ...facts,
      readings: { ...fine, urgency: "high" },
      replyAt: now.getTime() + 5 * HOUR,
    }).verdict
  ).toBe("deliver");
  expect(
    gateVerdictOf({
      ...facts,
      isAppOpen: true,
      readings: { ...fine, goodMoment: false },
    }).verdict
  ).toBe("deliver");
});

test("his reply hour: a median of his answers' hours, only when he answers in batches", () => {
  const row = (hour: number, wait: number) => ({
    days: ["2026-11-20"],
    got: 1,
    gotDeleted: 0,
    heOpened: false,
    hisAnswerHours: [hour],
    hisWaits: [wait],
    sent: 1,
    sentDeleted: 0,
    start: at(-24),
    theirWaits: [],
  });
  const batched = [20, 21, 21, 22, 21].map((h) => row(h, 300));
  expect(replyHourOf(batched, now)).toBe(21);
  expect(replyHourOf(batched.slice(0, 4), now)).toBeUndefined();
  expect(
    replyHourOf(
      [20, 21, 21, 22, 21].map((h) => row(h, 10)),
      now
    )
  ).toBeUndefined();
});

test("a batch instruction's next moment, in his zone", () => {
  const zone = "Asia/Bangkok";
  // 12:00Z is 19:00 in Bangkok: the next of 9:00 and 18:00 is tomorrow's 9:00.
  expect(nextBatchAtOf("at 9:00 and 18:00", now, zone)).toBe(
    Date.parse("2026-11-26T02:00:00.000Z")
  );
  expect(nextBatchAtOf("whenever", now, zone)).toBeUndefined();
});

test("his quiet beats the model's urgency: held, unless the deadline is within 3 hours", () => {
  const urgent = { ...fine, urgency: "high" as const };
  expect(verdict(urgent, { effect: "quiet" })).toBe("hold");
  expect(verdict(urgent, { deadline: at(2), effect: "quiet" })).toBe("deliver");
  expect(verdict(urgent)).toBe("deliver");
});

afterEach(() => rmSync(DECISIONS, { force: true }));

test("a failing gate never keeps a card from him: a failed call delivers it, and so does a card whose gating throws", async () => {
  const desk = {
    db: openDesk(join(mkdtempSync(join(tmpdir(), "life-gate-")), "d.sqlite")),
    runtimes: {},
  };
  const ask = (n: number) =>
    requestDecision("desk", {
      agent: "agt_0123456789ab",
      ask: `Pick a day ${n}`,
      context: "A made-up reason to ask.",
      // The real clock: requestDecision checks the deadline against now.
      deadline: iso(clock().getTime() + 48 * HOUR),
      follow: [],
      options: [
        { id: "tue", label: "Tuesday" },
        { id: "wed", label: "Wednesday" },
      ],
      question: `Which day suits you, ${n}?`,
      recommended: "tue",
      title: "Book the plumber",
    });
  const [a, b] = [await ask(1), await ask(2)];
  const failing = spyOn(run, "begin").mockRejectedValue(new Error("down"));
  // The first card's assignment can't be read: its gating throws.
  const card = spyOn(deskRead, "assignmentOfCard").mockImplementation(((
    _db: unknown,
    d: { id: string }
  ) => (d.id === a.id ? "asg_broken" : undefined)) as never);
  const turns = spyOn(deskRead, "lastTurns").mockImplementation(() => {
    throw new Error("a broken store");
  });
  try {
    await gateCards(desk);
  } finally {
    failing.mockRestore();
    card.mockRestore();
    turns.mockRestore();
  }
  const lines = decisionsNow().filter((d) => d.id === a.id || d.id === b.id);
  expect(
    lines.map((d) => [d.id, d.delivered?.verdict, d.delivered?.rules])
  ).toEqual([
    [a.id, "deliver", ["gate failed"]],
    [b.id, "deliver", ["failed open"]],
  ]);
});
