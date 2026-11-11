import { expect, test } from "bun:test";
import { iso, MIN } from "../core/clock";
import { digest } from "../core/hash";
import type { SourceEvent } from "../records/source";
import { nightsOf } from "../sources/apple-health";
import {
  deviceDayText,
  measurementDayText,
  photoDayText,
} from "./activity-days";
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
    headline: "slept 5 h; running, 315 kcal",
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

const shot = (
  id: string,
  at: string,
  photo: Partial<NonNullable<SourceEvent["photo"]>> = {}
): SourceEvent => ({
  at,
  chat: "photos",
  chatName: "Photos",
  fromMe: true,
  id: `photos:${id}`,
  photo: { pictured: [], scenes: [], ...photo },
  sender: "me",
  source: "photos",
  text: `photo ${id}`,
});

test("a photo-day groups photos by half hour and place, each line with what Photos and he say of them", () => {
  const ana = { handle: "+33 6 11 11 11 11", name: "Ana" };
  const list = [
    shot("c", "2026-10-09T08:20:00.000Z", {
      address: "1 Example Road, Exampleville",
      favorite: true,
      ocr: ["open", "daily"],
      pictured: [ana, { name: "Tom" }],
      place: "Seaside",
      point: { lat: 48.8566, lon: 2.3522 },
      scenes: ["Beach", "Sea"],
    }),
    shot("a", "2026-10-09T08:00:00.000Z", {
      caption: "First swim",
      // Photos names zones "GMT+0700": a different offset than Paris in summer shows, the same one does not.
      offset: 25_200,
      pictured: [ana],
      place: "Seaside",
      scenes: ["Beach"],
      zone: "GMT+0700",
    }),
    shot("b", "2026-10-09T08:10:00.000Z", {
      offset: 7200,
      place: "Seaside",
      scenes: ["Beach", "Sunset"],
      video: true,
      zone: "GMT+0200",
    }),
    // The same place, but more than half an hour after the last photo.
    shot("d", "2026-10-09T09:00:00.000Z", { place: "Seaside" }),
    // Half an hour later, somewhere else.
    shot("e", "2026-10-09T09:10:00.000Z", { place: "Old town" }),
    shot("f", "2026-10-09T09:12:00.000Z"),
  ];
  const result = photoDayText(list);
  expect(result.body).toBe(
    [
      '10:00–10:20 · Seaside · 1 Example Road, Exampleville · 48.8566, 2.3522 · 2 photos, 1 video · Beach, Sunset, Sea · with Ana, Tom · ★ 1 · zone GMT+0700 · "First swim" · text: open daily',
      "11:00 · Seaside · 1 photo",
      "11:10 · Old town · 1 photo",
      "11:12 · 1 photo",
    ].join("\n")
  );
  expect(result.headline).toBe("5 photos, 1 video · Seaside, Old town");
  expect(result.lines.map((e) => e.id)).toEqual(
    ["a", "b", "c", "d", "e", "f"].map((id) => `photos:${id}`)
  );
  expect(list[0]?.id).toBe("photos:c");

  const [day] = messageUnits(list, () => null);
  expect(day?.unit).toMatchObject({
    hash: digest("sha256", result.body, 16),
    people: ["person:me", "unknown:+33 6 11 11 11 11", "unknown:Tom"],
    refs: ["photos:a", "photos:f"],
    source: "photos",
    stats: { items: 6 },
    title: `Photos: ${result.headline}`,
  });
  expect(day?.messages.map((m) => m.id)).toHaveLength(6);
  expect(day?.text).toBe(`Photos: ${result.headline}\n${result.body}`);
});

test("a photo-day shows an address only when it says more than the place, and no zero count", () => {
  const { body, headline } = photoDayText([
    shot("a", "2026-10-09T08:00:00.000Z", {
      address: "Seaside, Exampleville",
      place: "Seaside",
      video: true,
    }),
    shot("b", "2026-10-09T10:00:00.000Z", {
      address: "Old town",
      place: "The Old town quarter",
      video: true,
    }),
  ]);
  expect(body).toBe(
    "10:00 · Seaside · Seaside, Exampleville · 1 video\n12:00 · The Old town quarter · 1 video"
  );
  expect(headline).toBe("2 videos · Seaside, The Old town quarter");
});

test("a photo-day's text is redacted", () => {
  const { body } = photoDayText([
    shot("a", "2026-10-09T08:00:00.000Z", {
      ocr: ["4111111111111111"],
      place: "Cafe",
    }),
  ]);
  expect(body).toBe("10:00 · Cafe · 1 photo · text: [number removed]");
});
