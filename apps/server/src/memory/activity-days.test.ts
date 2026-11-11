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

test("a measurement-day keeps every night and workout as a timed span, in order", () => {
  const [night] = nightsOf([
    {
      endAt: "2026-10-09T05:00:00Z",
      id: "night",
      kind: "sleep",
      stage: "asleep",
      startAt: "2026-10-09T00:00:00Z",
    },
  ]) as [SourceEvent];
  const workout: SourceEvent = {
    at: "2026-10-09T07:00:00.000Z",
    chat: "apple-health",
    chatName: "Apple Health",
    fromMe: true,
    id: "apple-health:run",
    sender: "me",
    source: "apple-health",
    text: "running, 315 kcal",
    until: "2026-10-09T07:42:00.000Z",
  };
  const list = [workout, night];
  const result = measurementDayText(list);
  expect(result).toEqual({
    body: "02:00–07:00 slept 5 h\n09:00–09:42 running, 315 kcal",
    headline: "slept 5 h, running, 315 kcal",
    lines: [night, workout],
  });
  expect(list[0]).toBe(workout);
  const [day] = messageUnits(list, () => null);
  expect(day?.unit.title).toBe(`Apple Health: ${result.headline}`);
  expect(day?.unit.summary).toBe(result.body.split("\n")[0]);
  expect(day?.messages.map((m) => m.id)).toEqual([night.id, workout.id]);
  expect(
    applyRules(messageUnits(list, () => null))[0]?.unit.drop
  ).toBeUndefined();
});

test("a night across a non-UTC midnight is one span on the day it began", () => {
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
  expect(events.map((e) => localDate(e.at))).toEqual(["2026-10-09"]);
  const days = messageUnits(events, () => null);
  expect(days.map((d) => [d.unit.date, d.text])).toEqual([
    [
      "2026-10-09",
      "Apple Health: slept 1 h 10 min\n23:30–00:40 slept 1 h 10 min",
    ],
  ]);
  expect(days[0]?.unit.end).toBe("2026-10-09T22:40:00.000Z");
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
