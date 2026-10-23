import { expect, test } from "bun:test";
import type { Dictation } from "@lifelog/db/schema";
import {
  blocked,
  type DictatedRange,
  dictatingSince,
  heldFrom,
  idle,
  isDictationApp,
  type MacEvent,
  nextChange,
  settle,
  step,
  unblocked,
} from "./dictation";

const app = "com.FluidApp.app";
const s = (seconds: number) => seconds * 1000;

// Feeds the events in order, then lets a long time pass; returns every range, in seconds.
function run(events: MacEvent[], state: Dictation = idle) {
  const ranges: DictatedRange[] = [];
  let current = state;
  for (const event of events) {
    const next = step(current, event);
    ranges.push(...next.ranges);
    current = next.state;
  }
  const last = settle(current, s(100_000));
  return {
    spans: [...ranges, ...last.ranges].map((r) => [
      r.startedAt / 1000,
      r.endedAt / 1000,
    ]),
    state: current,
  };
}
const mic = (at: number, ...capturing: string[]): MacEvent => ({
  at: s(at),
  capturing,
  kind: "mic",
});
// The flag on at each start, off at each end.
const dictations = (...spans: [number, number][]) =>
  spans.flatMap(([from, to]) => [mic(from, app), mic(to)]);

test("pads each dictation", () => {
  expect(run(dictations([10, 20])).spans).toEqual([[9, 21.5]]);
  const [range] = step(step(step(idle, mic(10, app)).state, mic(20)).state, {
    at: s(30),
    kind: "wake",
  }).ranges;
  expect(range?.source).toBe(app);
});

test("merges dictations less than five seconds apart", () => {
  expect(run(dictations([10, 20], [24, 30], [40, 50])).spans).toEqual([
    [9, 31.5],
    [39, 51.5],
  ]);
});

test("waits for the merge gap before a range is ready", () => {
  const waiting = step(step(idle, mic(0, app)).state, mic(10)).state;
  expect(nextChange(step(idle, mic(0, app)).state)).toBe(s(600) + 1);
  expect(nextChange(waiting)).toBe(s(15));
  expect(nextChange(idle)).toBeNull();
  expect(settle(waiting, s(14)).ranges).toEqual([]);
  expect(settle(waiting, s(14)).state.finished).not.toBeNull();
  expect(
    settle(waiting, s(15)).ranges.map((r) => [r.startedAt, r.endedAt])
  ).toEqual([[s(-1), s(11.5)]]);
});

test("drops dictations over ten minutes", () => {
  expect(run(dictations([0, 601])).spans).toEqual([]);
  expect(run(dictations([0, 300], [303, 700])).spans).toEqual([]); // merged, it is too long
});

test("drops a dictation cut by sleep, and the flag counts again once off", () => {
  const sleep: MacEvent = { at: s(105), kind: "sleep" };
  const wake: MacEvent = { at: s(106), kind: "wake" };
  expect(
    run([mic(0, app), mic(10), mic(100, app), sleep, wake, mic(110)]).spans
  ).toEqual([[-1, 11.5]]);
  expect(
    run([mic(100, app), sleep, wake, mic(110), ...dictations([120, 130])]).spans
  ).toEqual([[119, 131.5]]);
});

test("a flag stuck past ten minutes stops holding, and counts again once off", () => {
  const { state } = run([mic(0, app), mic(300, app, "us.zoom.xos")]);
  expect(heldFrom(state, s(300))).toBe(s(-1)); // a long dictation still holds
  expect(heldFrom(state, s(601))).toBeNull(); // stuck: the watermark moves on
  expect(dictatingSince(state, s(601))).toBeNull();
  const { state: stuck } = run([mic(601, app)], state);
  expect(step(stuck, mic(700)).ranges).toEqual([]);
  expect(run([mic(700), ...dictations([900, 910])], stuck).spans).toEqual([
    [899, 911.5],
  ]); // never sent; the next one is
});

test("sleep sends a dictation still waiting for a neighbour", () => {
  const waiting = step(step(idle, mic(0, app)).state, mic(10)).state;
  const asleep = step(waiting, { at: s(12), kind: "sleep" });
  expect(asleep.ranges.map((r) => [r.startedAt, r.endedAt])).toEqual([
    [s(-1), s(11.5)],
  ]);
  expect(asleep.state).toEqual({ ...idle, asleep: true });
  expect(step(asleep.state, { at: s(20), kind: "wake" }).state.asleep).toBe(
    false
  );
});

test("holds from a dictation until it is a range", () => {
  expect(heldFrom(idle, s(0))).toBeNull(); // nothing held: the server vouches through now
  const dictating = step(idle, mic(10, app)).state;
  expect(dictatingSince(dictating, s(11))).toBe(s(10));
  expect(heldFrom(dictating, s(11))).toBe(s(9)); // the open dictation's padded start
  const waiting = step(dictating, mic(20)).state;
  expect(dictatingSince(waiting, s(21))).toBeNull(); // stopped: no longer dictating
  expect(heldFrom(waiting, s(21))).toBe(s(9)); // still waiting for a neighbour
  expect(heldFrom(waiting, s(30))).toBe(s(9)); // due, but held until stored
  const stored = settle(waiting, s(30)).state;
  expect(heldFrom(stored, s(30))).toBeNull();
  // A refused event blocks from the padded instant before the Mac was last heard, whatever its age;
  // an earlier block or dictation stands.
  const stuck = blocked(stored, s(50));
  expect(heldFrom(stuck, s(100_000))).toBe(s(49));
  expect(blocked(stuck, s(80)).blockedSince).toBe(s(49));
  expect(heldFrom(blocked(dictating, s(50)), s(51))).toBe(s(9));
  // Closed, a dictation waiting for a neighbour goes at once.
  expect(settle(waiting, s(21), true).ranges).toHaveLength(1);
});

test("the first dictation app capturing is the source; other apps and their helpers don't count", () => {
  const source = (...capturing: string[]) =>
    step(idle, { at: 0, capturing, kind: "mic" }).state.open?.source ?? null;
  expect(source("com.apple.FaceTime", "com.electron.wispr-flow.helper")).toBe(
    "com.electron.wispr-flow.helper"
  );
  for (const name of [
    "com.FluidApp.app",
    "com.electron.wispr-flow.helper",
    "com.openai.codex.helper",
    "claude",
  ]) {
    expect(isDictationApp(name)).toBe(true);
  }
  // Held for hours with nobody dictating (Siri's listener), and Codex's audio visualizer.
  for (const name of [
    "com.apple.CoreSpeech",
    "com.openai.codex.system-audio-spectrum",
    "com.apple.FaceTime",
    "audiotee",
  ]) {
    expect(isDictationApp(name)).toBe(false);
  }
  // A call keeps the microphone, a dictation app stops: the dictation ends.
  expect(
    run([mic(0, app, "com.apple.FaceTime"), mic(5, "com.apple.FaceTime")]).spans
  ).toEqual([[-1, 6.5]]);
});

test("Windows images match their own table, case-insensitively, never by the Mac prefix rule", () => {
  for (const name of [
    "claude.exe",
    "Claude.exe",
    "ChatGPT.exe",
    "TextInputHost.exe",
    "Wispr Flow.exe",
  ]) {
    expect(isDictationApp(name)).toBe(true);
  }
  // Not dictation: a call, a browser, and names the Mac prefix rule would have taken.
  for (const name of [
    "Teams.exe",
    "chrome.exe",
    "claude.helper.exe",
    "com.openai.chat.exe",
  ]) {
    expect(isDictationApp(name)).toBe(false);
  }
  // The Mac keeps its prefix rule for helper processes.
  expect(isDictationApp("claude.helper")).toBe(true);
});

test("a dropped invalid event leaves its span as a range of unknown source; another block leaves none", () => {
  const lost = blocked(idle, s(10), true);
  expect(lost).toMatchObject({ blockedSince: s(9), lostFrom: s(9) });
  const cleared = unblocked(lost, s(20));
  expect(cleared.ranges).toEqual([
    { endedAt: s(21.5), source: "unknown", startedAt: s(9) },
  ]);
  expect(cleared.state).toEqual(idle);
  // A database failure: the same event comes again, so nothing was lost.
  expect(unblocked(blocked(idle, s(10)), s(20)).ranges).toEqual([]);
});
