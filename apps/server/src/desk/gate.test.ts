import { expect, test } from "bun:test";
import { HOUR, iso } from "../core/clock";
import { type GateReadings, gateVerdictOf, nextBatchAtOf } from "./gate";

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

test("a batch instruction's next moment, in his zone", () => {
  const zone = "Asia/Bangkok";
  // 12:00Z is 19:00 in Bangkok: the next of 9:00 and 18:00 is tomorrow's 9:00.
  expect(nextBatchAtOf("at 9:00 and 18:00", now, zone)).toBe(
    Date.parse("2026-11-26T02:00:00.000Z")
  );
  expect(nextBatchAtOf("whenever", now, zone)).toBeUndefined();
});
