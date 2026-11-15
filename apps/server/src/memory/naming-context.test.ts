import { expect, test } from "bun:test";
import { DAY, MIN } from "../core/clock";
import type { SourceEvent } from "../records/source";
import {
  BRIEF_CHARS,
  CALLS_CHARS,
  namingBriefOf,
  overlappingPhoneCallsOf,
  POSSIBLE_SPEAKERS,
  possibleSpeakersOf,
} from "./naming-context";

// Made-up people and calls. A part runs from 10:00 to 11:00 UTC on 30 Oct 2026 (the test zones: Lagos, UTC+1, since 19 Oct).
const FROM = "2026-10-30T10:00:00.000Z";
const TO = "2026-10-30T11:00:00.000Z";
const HANDLES: Record<string, string> = {
  "+15550000001": "person:ana",
  "+15550000002": "person:ben",
};
const people = {
  nameOf: (ref: string) => ref.replace("person:", "").toUpperCase(),
  resolve: (s: string) => HANDLES[s] ?? null,
};
const callAt = (
  at: string,
  seconds: number | undefined,
  o: Partial<SourceEvent> = {}
): SourceEvent => ({
  at,
  chat: "+15550000001",
  fromMe: false,
  id: `${at}-${o.chat ?? "+15550000001"}`,
  phoneCall: { seconds, video: false },
  sender: "+15550000001",
  source: "phone",
  text: "",
  ...o,
});
const minute = (min: number) =>
  new Date(Date.parse(FROM) + min * MIN).toISOString();
const peopleOn = (calls: SourceEvent[]) =>
  overlappingPhoneCallsOf(calls, FROM, TO, people).people;

test("a call overlaps the recording when its span does: a call ending as it starts or starting as it ends does not", () => {
  // 600 s calls: one ends exactly at FROM, one ends one second after it, one starts exactly at TO, one just before.
  expect(peopleOn([callAt(minute(-10), 600)])).toEqual([]);
  expect(peopleOn([callAt(minute(-10), 601)])).toEqual(["person:ana"]);
  expect(peopleOn([callAt(minute(60), 600)])).toEqual([]);
  expect(peopleOn([callAt(minute(59), 600)])).toEqual(["person:ana"]);
  // One that began long before and runs through it.
  expect(peopleOn([callAt(minute(-120), 3 * 3600)])).toEqual(["person:ana"]);
});

test("a call with no end seen counts only when it starts inside the span; one not picked up never does", () => {
  expect(peopleOn([callAt(minute(30), undefined)])).toEqual(["person:ana"]);
  expect(peopleOn([callAt(minute(0), undefined)])).toEqual(["person:ana"]);
  expect(peopleOn([callAt(minute(-1), undefined)])).toEqual([]);
  expect(peopleOn([callAt(minute(60), undefined)])).toEqual([]);
  expect(peopleOn([callAt(minute(30), 0)])).toEqual([]);
});

test("a call is with the person of its one-to-one chat, else with the senders of the calls of a group", () => {
  const group = (sender: string) =>
    callAt(minute(20), 900, { chat: "chat-group", sender });
  const calls = [
    callAt(minute(10), 900, { chat: "+15550000002", sender: "+15550000002" }),
    group("+15550000001"),
    // A group chat with two senders: only the one who called is on the call.
    { ...group("+15550000002"), fromMe: false, id: "other" },
  ];
  const { lines, people: on } = overlappingPhoneCallsOf(
    calls,
    FROM,
    TO,
    people
  );
  expect(on.toSorted()).toEqual(["person:ana", "person:ben"]);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("with BEN");
  expect(lines[0]).toContain("audio call");
});

test("the calls shown stop at 600 characters, and every person on a call is still counted", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    callAt(minute(i), 3600, { id: `call-${i}` })
  );
  const { lines, people: on } = overlappingPhoneCallsOf(many, FROM, TO, people);
  expect(lines.join("").length).toBeLessThanOrEqual(CALLS_CHARS);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.length).toBeLessThan(30);
  expect(on).toEqual(["person:ana"]);
});

const none = {
  answered: [] as string[],
  facts: [] as string[],
  heard: [] as { at: string; ref: string }[],
  onCall: [] as string[],
  pictured: [] as string[],
};
const possible = (signs: Partial<typeof none>) =>
  possibleSpeakersOf({ ...none, ...signs }, FROM, FROM);

test("a person with none of the signs is not offered, even when lifelog named the voice by sound", () => {
  // Lifelog's name is not a sign: a person who lives elsewhere, with no call, no answer, no photo and no fact.
  expect(possible({})).toEqual([]);
});

test("each sign alone makes a person possible; callers come first", () => {
  expect(
    possible({
      answered: ["person:b"],
      facts: ["person:e"],
      heard: [{ at: "2026-10-20T10:00:00.000Z", ref: "person:c" }],
      onCall: ["person:a"],
      pictured: ["person:d"],
    })
  ).toEqual(["person:a", "person:b", "person:c", "person:d", "person:e"]);
  for (const sign of ["answered", "facts", "onCall", "pictured"] as const) {
    expect(possible({ [sign]: ["person:x"] })).toEqual(["person:x"]);
  }
  // Him and non-people are never offered.
  expect(possible({ onCall: ["person:me", "unknown:x", "person:x"] })).toEqual([
    "person:x",
  ]);
});

test("heard in person counts only before the conversation, within 90 days, at the same UTC offset", () => {
  const heard = (when: string, ref: string) => ({ at: when, ref });
  expect(
    possible({
      heard: [
        // Before, in the same zone (Lagos, UTC+1): in.
        heard("2026-10-20T10:00:00.000Z", "person:in"),
        // Where he was at UTC+7 then: out.
        heard("2026-09-10T10:00:00.000Z", "person:far"),
        // 92 days before, a summer in Lisbon (UTC+1): out by the window.
        heard("2026-07-30T10:00:00.000Z", "person:old"),
        // After the conversation began: out.
        heard("2026-10-30T10:00:01.000Z", "person:later"),
      ],
    })
  ).toEqual(["person:in"]);
});

test("at most 12 are offered, those on a call before the rest, the most recently heard first", () => {
  const heard = Array.from({ length: 20 }, (_, i) => ({
    at: new Date(
      Date.parse("2026-10-20T10:00:00.000Z") + (i * DAY) / 4
    ).toISOString(),
    ref: `person:h${String(i).padStart(2, "0")}`,
  }));
  const offered = possible({ heard, onCall: ["person:caller"] });
  expect(offered).toHaveLength(POSSIBLE_SPEAKERS);
  expect(offered.slice(0, 2)).toEqual(["person:caller", "person:h19"]);
});

test("a brief holds what he is to them, their language, family and home, how he met them and who is often with them, in 300 characters", () => {
  const brief = namingBriefOf({
    byCall: ["2026-10-02"],
    details: [
      { from: "contacts", kind: "home", text: "Lyon" },
      { from: "contacts", kind: "family", text: "sister: Mia" },
      { from: "contacts", kind: "work", text: "ignored" },
    ],
    inPerson: ["2026-10-20", "2026-10-25", "2026-10-26"],
    language: "fr",
    often: ["Ben", "Cleo"],
    relation: "close friend",
  });
  expect(brief).toBe(
    "close friend; speaks French; lives in Lyon; family sister: Mia; heard in person on 3 days, by call on 1 days, last on 2026-10-26; often recorded the same days as Ben and Cleo"
  );
  const long = namingBriefOf({
    byCall: [],
    details: [{ from: "truth", kind: "family", text: "word ".repeat(200) }],
    inPerson: [],
    often: [],
  });
  expect(long.length).toBeLessThanOrEqual(BRIEF_CHARS);
  expect(
    namingBriefOf({ byCall: [], details: [], inPerson: [], often: [] })
  ).toBe("heard in person on 0 days, by call on 0 days");
});
