import { expect, test } from "bun:test";
import { DAY, HOUR, MIN } from "../core/clock";
import {
  integrationHealthOf,
  toneOf,
  waking,
  wokeAt,
} from "./integration-health";

const now = Date.parse("2026-10-21T15:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

test("a source is red only when Life can't read it; silence is quiet, then amber past its limit", () => {
  expect(toneOf(ago(10 * MIN), DAY, now)).toEqual({
    tone: "ok",
    word: "receiving",
  });
  expect(toneOf(ago(5 * HOUR), DAY, now)).toEqual({
    tone: "idle",
    word: "quiet",
  });
  expect(toneOf(ago(25 * HOUR), DAY, now)).toEqual({
    tone: "warn",
    word: "silent",
  });
  expect(toneOf(ago(MIN), DAY, now, false)).toEqual({
    tone: "bad",
    word: "unreadable",
  });
  expect(toneOf(null, DAY, now)).toEqual({ tone: "idle", word: "nothing yet" });
});

test("the Pendant is expected to hear him between 08:00 and 01:00 only, on the clock of the zone given", () => {
  // Lagos is UTC+1 all year: 06:30Z is 07:30 there.
  const at = (h: number) => new Date(Date.UTC(2026, 9, 21, h - 1, 30));
  expect(
    [7, 8, 13, 23, 24, 25, 28].map((h) => waking(at(h), "Africa/Lagos"))
  ).toEqual([false, true, true, true, true, false, false]);
  // The same instant in another zone: 07:30 in Lagos is 13:30 in Jakarta.
  expect(waking(at(7), "Asia/Jakarta")).toBe(true);
});

test("his waking hours began at 08:00, the day before after midnight: a night is not silence", () => {
  const lagos = (day: number, h: number) =>
    new Date(Date.UTC(2026, 9, day, h - 1, 30));
  const eight = new Date("2026-10-21T07:00:00.000Z");
  expect(wokeAt(lagos(21, 9), "Africa/Lagos")).toEqual(eight);
  expect(wokeAt(lagos(22, 0), "Africa/Lagos")).toEqual(eight);
  expect(wokeAt(lagos(22, 4), "Africa/Lagos")).toBeNull();
});

test("an integration turned off is off", () => {
  expect(
    integrationHealthOf({
      answering: true,
      kind: "voice",
      line: "",
      on: false,
      requirements: [],
    })
  ).toEqual({ state: "off", tone: "idle", word: "off" });
});

test("an unmet requirement wins over a failing read", () => {
  expect(
    integrationHealthOf({
      kind: "source",
      now,
      on: true,
      read: { error: "no such table", ok: false },
      requirements: [
        { check: "full_disk_access", done: false, kind: "permission" },
      ],
      silentAfter: DAY,
    })
  ).toEqual({
    state: "waiting_on_user",
    tone: "bad",
    why: "Turn on Full Disk Access for Life in System Settings.",
    word: "can't read",
  });
});

test("an import that is not there yet waits, quiet", () => {
  expect(
    integrationHealthOf({
      imported: true,
      kind: "source",
      missing: "not imported",
      now,
      on: true,
      read: { at: null, ok: true },
      requirements: [],
      silentAfter: DAY,
    })
  ).toEqual({
    state: "waiting_on_user",
    tone: "idle",
    why: "not imported",
    word: "not imported",
  });
});

test("a store that fails is broken, whatever it last read", () => {
  expect(
    integrationHealthOf({
      kind: "source",
      now,
      on: true,
      read: { at: ago(MIN), ok: true },
      requirements: [],
      silentAfter: DAY,
      storeFailing: "database is locked",
    })
  ).toEqual({
    state: "broken",
    tone: "bad",
    why: "database is locked",
    word: "unreadable",
  });
});

test("a bridge that is down is broken", () => {
  expect(
    integrationHealthOf({
      bridgeDown: "the bridge is not answering",
      kind: "source",
      now,
      on: true,
      read: { at: ago(MIN), ok: true },
      requirements: [],
      silentAfter: DAY,
    })
  ).toEqual({
    state: "broken",
    tone: "bad",
    why: "the bridge is not answering",
    word: "bridge down",
  });
});

test("a source that has read nothing yet is connecting", () => {
  expect(
    integrationHealthOf({
      kind: "source",
      now,
      on: true,
      read: { at: null, ok: true },
      requirements: [],
      silentAfter: DAY,
    })
  ).toEqual({ state: "connecting", tone: "idle", word: "nothing yet" });
});

test("a source that just heard something is working", () => {
  expect(
    integrationHealthOf({
      kind: "source",
      now,
      on: true,
      read: { at: ago(10 * MIN), ok: true },
      requirements: [],
      silentAfter: DAY,
    })
  ).toEqual({ state: "working", tone: "ok", word: "receiving" });
});

test("the pendant with a phone that stopped reporting is broken", () => {
  expect(
    integrationHealthOf({
      heardAt: ago(MIN),
      kind: "pendant",
      now,
      on: true,
      phoneSilent: true,
      readable: true,
      recording: true,
      requirements: [],
      silentAfter: DAY,
    })
  ).toEqual({
    state: "broken",
    tone: "bad",
    why: "Your phone hasn't reported to this computer for 12 hours.",
    word: "phone not reporting",
  });
});

test("the voice engine not answering carries its line", () => {
  expect(
    integrationHealthOf({
      answering: false,
      kind: "voice",
      line: "The voice server is not running.",
      on: true,
      requirements: [],
    })
  ).toEqual({
    state: "broken",
    tone: "bad",
    why: "The voice server is not running.",
    word: "not answering",
  });
});

test("the AI offline is broken, and says where it could not reach", () => {
  expect(
    integrationHealthOf({
      host: "api.anthropic.com",
      kind: "ai",
      on: true,
      online: false,
      requirements: [],
    })
  ).toEqual({
    state: "broken",
    tone: "bad",
    why: "Can't reach api.anthropic.com: no internet, or it is down.",
    word: "offline",
  });
});
