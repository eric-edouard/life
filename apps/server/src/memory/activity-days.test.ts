import { expect, test } from "bun:test";
import { iso, MIN } from "../core/clock";
import { digest } from "../core/hash";
import type { SourceEvent } from "../records/source";
import { nightsOf } from "../sources/apple-health";
import { deviceDayText, measurementDayText } from "./activity-days";
import { applyRules, messageUnits } from "./units";
import { localDate } from "./zones";

const stint = (from: number, until: number, text: string): SourceEvent => ({
  at: iso(Date.parse("2026-10-09T10:00:00.000Z") + from * MIN),
  chat: "DEVICE-2",
  chatName: "Tablet",
  fromMe: true,
  id: `screen:DEVICE-2/${from}`,
  sender: "me",
  source: "screen",
  text,
  until: iso(Date.parse("2026-10-09T10:00:00.000Z") + until * MIN),
});

test("measurement-day totals precede its sleep, workouts and weight; only present quantities appear", () => {
  const event = (
    id: string,
    at: string,
    text: string,
    measured?: SourceEvent["measured"],
    until?: string
  ): SourceEvent => ({
    at: `2026-10-09T${at}:00.000Z`,
    chat: "apple-health",
    chatName: "Apple Health",
    fromMe: true,
    id: `apple-health:${id}`,
    ...(measured ? { measured } : {}),
    sender: "me",
    source: "apple-health",
    text,
    ...(until ? { until: `2026-10-09T${until}:00.000Z` } : {}),
  });
  const woke = event("wake", "05:00", "woke: 7 h 5 min asleep", {
    asleepMs: 425 * MIN,
    kind: "sleep",
  });
  const workout = event(
    "run",
    "07:00",
    "running, 315 kcal",
    { activity: "running", kcal: 315, kind: "workout" },
    "07:42"
  );
  const weight = event("weight", "08:00", "weight 68.2 kg", {
    kind: "weight",
    value: 68.2,
  });
  const list = [
    weight,
    workout,
    woke,
    event("steps-1", "10:00", "4,200 steps", { kind: "steps", value: 4200 }),
    event("steps-2", "11:00", "", { kind: "steps", value: 4212 }),
    event("rest", "10:00", "", { kind: "resting_heart_rate", value: 57 }),
    event("hrv-1", "10:00", "", { kind: "heart_rate_variability", value: 38 }),
    event("hrv-2", "11:00", "", { kind: "heart_rate_variability", value: 44 }),
  ];
  const result = measurementDayText(list);
  expect(result).toEqual({
    body: "Totals: 8,412 steps, resting heart rate 57 bpm, HRV 41 ms\n07:00 woke: 7 h 5 min asleep\n09:00–09:42 running, 315 kcal\n10:00 weight 68.2 kg",
    headline: "slept 7 h 5 min, 8,412 steps, running 42 min",
    lines: [woke, workout, weight],
  });
  expect(list[0]).toBe(weight);
  const [day] = messageUnits(list, () => null);
  expect(day?.unit.title).toBe(`Apple Health: ${result.headline}`);
  expect(day?.unit.summary).toBe(result.body.split("\n")[0]);
  expect(day?.messages.map((m) => m.id)).toEqual([
    woke.id,
    workout.id,
    weight.id,
  ]);
  const onlySteps = measurementDayText(list.slice(3, 4));
  expect(onlySteps).toEqual({
    body: "Totals: 4,200 steps",
    headline: "4,200 steps",
    lines: [],
  });
  const [stepsDay] = messageUnits(list.slice(3, 4), () => null);
  expect(stepsDay?.text).toContain("Totals: 4,200 steps");
  expect(stepsDay?.messages.map((m) => m.text)).toEqual(["4,200 steps"]);
  expect(measurementDayText([weight]).body).toBe("10:00 weight 68.2 kg");
  expect(
    applyRules(messageUnits(list.slice(3, 4), () => null))[0]?.unit.drop
  ).toBeUndefined();
  expect(
    applyRules(
      messageUnits([event("sleep", "21:00", "fell asleep")], () => null)
    )[0]?.unit.drop
  ).toBeUndefined();
});

test("a night across a non-UTC midnight carries its sleep on the wake day's measurement-day", () => {
  // The fixture is in Europe/Berlin: both instants are on the same UTC date.
  const events = nightsOf([
    {
      endAt: "2026-10-09T22:40:00Z",
      id: "night",
      kind: "sleep",
      stage: "asleep",
      startAt: "2026-10-09T21:30:00Z",
    },
  ]);
  expect(events.map((e) => localDate(e.at))).toEqual([
    "2026-10-09",
    "2026-10-10",
  ]);
  const days = messageUnits(events, () => null);
  expect(days.map((d) => [d.unit.date, d.text])).toEqual([
    ["2026-10-09", "Apple Health: fell asleep\n23:30 fell asleep"],
    [
      "2026-10-10",
      "Apple Health: slept 1 h 10 min\n00:40 woke: 1 h 10 min asleep",
    ],
  ]);
});

test("device-day text keeps totals, ordered long stints and stored content without sorting its input", () => {
  const short = stint(0, 2, "com.example.editor");
  const app = stint(20, 80, "com.example.editor");
  const web = stint(25, 30, "web: example.org");
  const list = [web, short, app];
  const body =
    "Time: com.example.editor 1 h 2 min, web: example.org 5 min\n12:20–13:20 com.example.editor\n12:25–12:30 web: example.org";
  const headline = "1 h 2 min in apps, most com.example.editor 1 h 2 min";
  const title = `Tablet: ${headline}`;
  expect(deviceDayText(list)).toEqual({ body, headline, lines: [app, web] });
  expect(list).toEqual([web, short, app]);
  const [day] = messageUnits(list, () => null);
  expect(day?.text).toBe(`${title}\n${body}`);
  expect(day?.unit).toMatchObject({
    end: app.until,
    hash: digest("sha256", body, 16),
    start: short.at,
    stats: { chars: body.length },
    summary: body.split("\n")[0],
    title,
  });
  expect(day?.messages.map((m) => m.id)).toEqual([app.id, web.id]);

  expect(deviceDayText([short])).toEqual({
    body: "Time: com.example.editor 2 min",
    headline: "2 min in apps, most com.example.editor 2 min",
    lines: [],
  });
  expect(messageUnits([short], () => null)[0]?.messages[0]?.id).toBe(short.id);
});
