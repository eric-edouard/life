import { expect, test } from "bun:test";
import { DAY, MIN } from "../core/clock";
import type { SourceEvent } from "../records/source";
import {
  BRIEF_CHARS,
  CALLS_CHARS,
  expectedCompanyOf,
  isNameSaid,
  namingBriefOf,
  namingConfidenceOf,
  overlappingPhoneCallsOf,
  POSSIBLE_SPEAKERS,
  plannedPeopleOf,
  possibleSpeakersOf,
  voiceGroupsOf,
  whyOf,
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

test("a group call he started is with the senders of the group's chat", () => {
  const calls = [
    callAt(minute(10), 900, { chat: "chat-g2", fromMe: true, sender: "me" }),
    {
      ...callAt(minute(-90), 0, { chat: "chat-g2", sender: "+15550000002" }),
      phoneCall: undefined,
      text: "hello",
    },
  ];
  const { lines, people: on } = overlappingPhoneCallsOf(
    calls,
    FROM,
    TO,
    people
  );
  expect(on).toEqual(["person:ben"]);
  expect(lines[0]).toContain("with BEN");
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
  expected: [] as string[],
  facts: [] as string[],
  heard: [] as { at: string; ref: string }[],
  onCall: [] as string[],
  pictured: [] as string[],
  scheduled: [] as string[],
};
const possible = (signs: Partial<typeof none>) =>
  possibleSpeakersOf({ ...none, ...signs }, FROM, FROM, TO, () => false);

test("an organization is never offered as a speaker, whatever its signs", () => {
  expect(
    possibleSpeakersOf(
      { ...none, onCall: ["person:test-shop", "person:ana"] },
      FROM,
      FROM,
      TO,
      (r) => r === "person:test-shop"
    )
  ).toEqual(["person:ana"]);
});

test("a person with none of the signs is not offered, even when lifelog named the voice by sound", () => {
  // Lifelog's name is not a sign: a person who lives elsewhere, with no call, no answer, no photo and no fact.
  expect(possible({})).toEqual([]);
});

test("each sign alone makes a person possible; callers come first, then his answers, then his expected company", () => {
  expect(
    possible({
      answered: ["person:b"],
      expected: ["person:f"],
      facts: ["person:e"],
      heard: [{ at: "2026-10-20T10:00:00.000Z", ref: "person:c" }],
      onCall: ["person:a"],
      pictured: ["person:d"],
      scheduled: ["person:g"],
    })
  ).toEqual([
    "person:a",
    "person:b",
    "person:f",
    "person:g",
    "person:c",
    "person:d",
    "person:e",
  ]);
  for (const sign of [
    "answered",
    "expected",
    "facts",
    "onCall",
    "pictured",
    "scheduled",
  ] as const) {
    expect(possible({ [sign]: ["person:x"] })).toEqual(["person:x"]);
  }
  // Him and non-people are never offered.
  expect(possible({ onCall: ["person:me", "unknown:x", "person:x"] })).toEqual([
    "person:x",
  ]);
});

test("heard in person counts in another conversation, within 90 days either side, at the same UTC offset", () => {
  const heard = (when: string, ref: string) => ({ at: when, ref });
  expect(
    possible({
      heard: [
        // Before, in the same zone (Lagos, UTC+1): in.
        heard("2026-10-20T10:00:00.000Z", "person:in"),
        // After the conversation ended (its end is TO), the same zone: in.
        heard("2026-11-05T10:00:00.000Z", "person:after"),
        // Where he was at UTC+7 then: out.
        heard("2026-09-10T10:00:00.000Z", "person:far"),
        // 92 days before, a summer in Lisbon (UTC+1): out by the window.
        heard("2026-07-30T10:00:00.000Z", "person:old"),
        // Inside the conversation (from FROM to TO): out.
        heard("2026-10-30T10:30:00.000Z", "person:during"),
        // More than 90 days after: out.
        heard("2027-02-05T10:00:00.000Z", "person:late"),
      ],
    }).toSorted()
  ).toEqual(["person:after", "person:in"]);
});

// His report of 22 Nov: a client met by video, set by mail for that day, was never offered: 12 people heard in the 90
// days filled the list first.
test("a plan for that day is offered before the people heard in the 90 days, who cannot crowd it out", () => {
  const heard = Array.from({ length: 12 }, (_, i) => ({
    at: `2026-10-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`,
    ref: `person:heard-${i}`,
  }));
  expect(possible({ heard, scheduled: ["person:client"] })).toContain(
    "person:client"
  );
});

// His report of 22 Nov: a client meeting set by an invitation was planned with the client's project, not its guests.
test("a plan's project or organization brings its people, an organization's past members left out", () => {
  const party = (id: string, projects: string[] = []) => ({
    aliases: [],
    handles: {},
    id,
    name: id,
    projects,
  });
  const truth = {
    chats: [],
    organizations: [
      {
        ...party("acme", ["site"]),
        domains: [],
        people: [
          { id: "ceo", role: "CEO" },
          { id: "old", role: "sales", until: 2025 },
        ],
      },
    ],
    people: [party("dev", ["site"])],
    projects: [{ chats: [], id: "site", people: ["lead"] }],
  } as unknown as Parameters<typeof plannedPeopleOf>[1];
  expect(plannedPeopleOf("project:site", truth)).toEqual([
    "person:dev",
    "person:ceo",
  ]);
  expect(plannedPeopleOf("person:acme", truth)).toEqual(["person:ceo"]);
  expect(plannedPeopleOf("person:ana", truth)).toEqual(["person:ana"]);
  expect(plannedPeopleOf("project:other", truth)).toEqual(["project:other"]);
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

test("his expected company: a one-to-one message or call from 6 hours before the conversation to its end, nearest its start first, with the chats' titles", () => {
  const message = (
    ref: string,
    at: string,
    chatName?: string
  ): [string, SourceEvent[]] => [
    ref,
    [{ ...callAt(at, undefined), chatName, phoneCall: undefined }],
  ];
  const direct = new Map<string, SourceEvent[]>([
    message("person:far", minute(-5 * 60), "Far"),
    message("person:near", minute(-20), "Ana / Annie"),
    message("person:during", minute(30)),
    message("person:before", minute(-7 * 60)),
    message("person:after", minute(61)),
  ]);
  expect(expectedCompanyOf(direct, FROM, TO)).toEqual([
    { away: 20 * MIN, chats: ["Ana / Annie"], ref: "person:near" },
    { away: 30 * MIN, chats: [], ref: "person:during" },
    { away: 5 * 60 * MIN, chats: ["Far"], ref: "person:far" },
  ]);
});

test("how sure a guess is, counted by code: sure needs the model's sure, two signals and nothing elsewhere; likely one signal", () => {
  expect(namingConfidenceOf("sure", 2, false)).toBe("sure");
  expect(namingConfidenceOf("sure", 3, true)).toBe("likely");
  expect(namingConfidenceOf("sure", 1, false)).toBe("likely");
  expect(namingConfidenceOf("likely", 4, false)).toBe("likely");
  expect(namingConfidenceOf("sure", 0, false)).toBe("weak");
  expect(namingConfidenceOf("weak", 3, false)).toBe("weak");
});

test("a name said is a whole word of 3 letters or more of the person's name or a chat title, accents and case aside", () => {
  expect(isNameSaid(["Hey! Zoé, you came"], ["Zoe Martin"])).toBe(true);
  expect(isNameSaid(["hey zara"], ["Zoe Martin", "Zara / Zoe"])).toBe(true);
  expect(isNameSaid(["the zoetrope"], ["Zoe"])).toBe(false);
  expect(isNameSaid(["al is here"], ["Al"])).toBe(false);
});

test("a voice group is one V across recordings; a voice in no group is its own; each group lists its voices' lines", () => {
  const groups = voiceGroupsOf(
    [
      null,
      "job-1 speaker_1",
      "job-2 speaker_0",
      "job-1 speaker_2",
      "job-1 speaker_1",
    ],
    (v) =>
      v === "job-1 speaker_1" || v === "job-2 speaker_0" ? "g1" : undefined
  );
  expect(groups.lineTokens).toEqual([null, "V1", "V1", "V2", "V1"]);
  expect([...groups.members].map(([t, m]) => [t, [...m]])).toEqual([
    [
      "V1",
      [
        ["job-1 speaker_1", [1, 4]],
        ["job-2 speaker_0", [2]],
      ],
    ],
    ["V2", [["job-1 speaker_2", [3]]]],
  ]);
});

test("a guess's why is its most telling signal: the plan, then the message before with its app and time, then the rest", () => {
  const message = {
    at: "2026-10-30T09:30:00.000Z",
    source: "instagram",
    text: "On my way",
  } as SourceEvent;
  const none = { named: false, onCall: false, sounds: false };
  expect(whyOf({ ...none, plan: "lunch with Ana", planned: message })).toBe(
    "Planned that day: lunch with Ana"
  );
  expect(whyOf({ ...none, planned: message, sounds: true })).toBe(
    "Instagram, 10:30: On my way"
  );
  expect(whyOf({ ...none, named: true, onCall: true })).toBe(
    "On a call at that time"
  );
  expect(whyOf(none)).toBeNull();
});
