import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import { apply } from "../sources/lifelog";
import {
  conversation,
  lifelogServer,
  lifelogStore,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { exchangeCountsOf, pairCountsOf } from "./exchange-counts";
import { personaPath } from "./memory-files";
import {
  backingOf,
  betweenOf,
  groupDaysOf,
  isDue,
  personaBlock,
  personaLines,
  personaShownOf,
  personaWindowOf,
  readingsOf,
  readPersona,
  recordingsOf,
  sampleOf,
  shownDaysOf,
  spokenOf,
} from "./personas";
import type { Truth } from "./read-truth";
import { unit as unitFixture } from "./record-fixtures";
import { inputsOf } from "./run";

const whoOf = (e: SourceEvent) => (e.fromMe ? "him" : "Dad");

// Noon UTC: the same local day in any zone a test runs in.
const msg = (
  day: string,
  minute: number,
  fromMe: boolean,
  text: string,
  extra: Partial<SourceEvent> = {}
): SourceEvent => ({
  at: new Date(
    Date.parse(`${day}T12:00:00.000Z`) + minute * 60_000
  ).toISOString(),
  chat: "+1",
  fromMe,
  id: `${day}:${minute}`,
  sender: fromMe ? "me" : "+1",
  source: "whatsapp",
  text,
  ...extra,
});

test("a sample keeps the newest days, the eventful ones and some across the years, oldest first, within its budget", () => {
  const quiet = Array.from({ length: 40 }, (_, i) =>
    msg(
      `2024-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + Math.floor(i / 12)).padStart(2, "0")}`,
      0,
      true,
      "x".repeat(80)
    )
  );
  const fight = [0, 1, 2, 3, 4].map((m) =>
    msg("2023-06-10", m, m % 2 === 0, "y".repeat(80), { deleted: m > 2 })
  );
  const newest = msg("2026-11-01", 0, false, "z".repeat(80));
  const days = sampleOf(
    shownDaysOf([...quiet, ...fight, newest], "direct", whoOf, () => "Ana"),
    2000
  );
  const shown = days.map((d) => d.day);
  expect(shown.at(-1)).toBe("2026-11-01");
  expect(shown).toContain("2023-06-10");
  expect(shown).toEqual(shown.toSorted());
  const chars = days
    .flatMap((d) => d.messages)
    .reduce((n, m) => n + m.text.length + 20, 0);
  expect(chars).toBeLessThanOrEqual(2000);
  expect(days.find((d) => d.day === "2023-06-10")?.messages[4]?.deleted).toBe(
    true
  );
});

test("a quote stays only as words in a chat message shown, a writing line's only from that writer, with the message's time", () => {
  const days = [
    ...shownDaysOf(
      [
        msg("2026-10-01", 0, false, "C'est encore de ta faute !"),
        msg("2026-10-01", 1, true, "Ok ça marche, à demain"),
        msg("2026-10-02", 0, false, "Pardon mon fils", { source: "mail" }),
      ],
      "direct",
      whoOf,
      () => "Dad"
    ),
    // How he writes in a group is not how he writes to them: quotable, never a writing line's.
    ...shownDaysOf(
      [msg("2026-10-03", 0, true, "Salut la famille", { chat: "family" })],
      "group",
      whoOf,
      () => "Family (group)"
    ),
  ];
  const reply = {
    lines: [
      {
        facet: "pattern",
        quotes: [
          "c'est encore de ta faute",
          "pardon mon fils",
          "never said",
          "salut la famille",
        ],
        text: "He blames, then apologises.",
        writer: null,
      },
      {
        facet: "writes",
        kind: "chat",
        quotes: ["ok ca marche", "de ta faute", "salut la famille"],
        source: "line",
        text: "Short, warm.",
        writer: "owner",
      },
      { facet: "offers", quotes: [], text: "Gives time when asked." },
      { facet: "horoscope", quotes: [], text: "Not a kind." },
    ],
  };
  expect(personaLines(reply, days)).toEqual([
    {
      facet: "pattern",
      quotes: [
        { at: "2026-10-01T12:00:00.000Z", text: "C'est encore de ta faute" },
        { at: "2026-10-03T12:00:00.000Z", text: "Salut la famille" },
      ],
      text: "He blames, then apologises.",
    },
    {
      facet: "writes",
      kind: "chat",
      quotes: [{ at: "2026-10-01T12:01:00.000Z", text: "Ok ça marche" }],
      text: "Short, warm.",
      writer: "owner",
    },
    { facet: "offers", quotes: [], text: "Gives time when asked." },
  ]);
  expect(personaLines("not json", days)).toEqual([]);
});

test("a line is solid on 3 days, thin on fewer, old when its newest quote is over a year old", () => {
  const q = (day: string) => ({ at: `${day}T12:00:00.000Z`, text: "x" });
  const today = "2026-11-08";
  expect(
    backingOf([q("2026-01-01"), q("2026-02-01"), q("2026-03-01")], today)
  ).toBe("solid");
  expect(backingOf([q("2026-01-01"), q("2026-01-01")], today)).toBe("thin");
  expect(backingOf([], today)).toBe("thin");
  expect(
    backingOf([q("2024-01-01"), q("2024-02-01"), q("2025-01-01")], today)
  ).toBe("old");
});

test("a persona is rebuilt when there is none, or a week old with new messages", () => {
  const now = new Date("2026-11-08T00:00:00.000Z");
  const last = { built: "2026-11-05T00:00:00.000Z", inputs: "a" };
  expect(isDue(null, "a", now)).toBe(true);
  expect(isDue(last, "b", now)).toBe(false);
  expect(isDue({ ...last, built: "2026-11-01T00:00:00.000Z" }, "b", now)).toBe(
    true
  );
  expect(isDue({ ...last, built: "2026-11-01T00:00:00.000Z" }, "a", now)).toBe(
    false
  );
});

test("a reader shows the readings with their backing, and the writing lines under How each writes", () => {
  const q = { at: "2026-11-01T12:00:00.000Z", text: "haha ok" };
  const block = personaBlock(
    {
      gist: "Steady, slow to answer; give one clear ask.",
      lines: [
        { facet: "reacts", quotes: [q], text: "Goes quiet when pressed." },
        {
          facet: "writes",
          kind: "chat",
          quotes: [q],
          source: "whatsapp",
          text: "Short.",
          writer: "them",
        },
      ],
    },
    "2026-11-08"
  );
  expect(block[1]).toBe(
    "- in short: Steady, slow to answer; give one clear ask."
  );
  expect(block[2]).toBe(
    '- reacts (thin): Goes quiet when pressed. E.g. "haha ok" (2026-11-01)'
  );
  expect(block[5]).toBe(
    '- they write, chat (whatsapp): Short. E.g. "haha ok" (2026-11-01)'
  );
  expect(
    readingsOf([
      { facet: "pattern", quotes: [q], text: "Blames, then makes up." },
      {
        facet: "writes",
        kind: null,
        quotes: [q],
        text: "Short.",
        writer: "them",
      },
    ]).map((l) => l.facet)
  ).toEqual(["pattern"]);
  expect(personaBlock(null, "2026-11-08")).toEqual([]);
});

test("his recordings with someone: the voice units they spoke in, a chapter weighed by its turns like any", () => {
  const unit = (id: string, people: string[], extra: Partial<Unit> = {}) =>
    ({
      date: "2026-11-01",
      end: "2026-11-01T13:00:00.000Z",
      hash: "h",
      id,
      key: id,
      people,
      refs: [],
      schemaVersion: 1,
      source: "lifelog",
      start: "2026-11-01T12:00:00.000Z",
      stats: { chars: 0, fromMe: 2, items: 5 },
      title: "Lunch",
      ...extra,
    }) as Unit;
  const got = recordingsOf(
    [
      unit("a", ["person:me", "person:dad"]),
      unit("b", ["person:me", "person:ana"]),
      unit("c", ["person:dad"], { summary: "They talked about the house." }),
      unit("d", ["person:dad"], { source: "whatsapp" }),
    ],
    new Set(["person:dad"])
  );
  expect(got.map((r) => [r.unit.id, r.size])).toEqual([
    ["a", 600],
    ["c", 600],
  ]);
});

test("a group chat-day goes to whoever wrote in it, with only his and their lines; a 1:1 is never a group", () => {
  const g = (minute: number, sender: string, fromMe = false) =>
    msg("2026-10-05", minute, fromMe, `m${minute}`, {
      chat: "family@g.us",
      sender,
    });
  const group = [g(0, "+2"), g(1, "+3"), g(2, "me", true)];
  const oneToOne = [
    msg("2026-10-05", 0, false, "hi", {
      chat: "+9@s.whatsapp.net",
      sender: "+9",
    }),
  ];
  const said = new Map(
    [...group, ...oneToOne].map((e) => [
      e,
      e.fromMe ? "person:me" : `person:${e.sender.slice(1)}`,
    ])
  );
  const days = groupDaysOf([...group, ...oneToOne], said);
  expect(days.map((d) => d.map((e) => e.text))).toEqual([["m0", "m1", "m2"]]);
  const of = (refs: string[]) =>
    betweenOf(days[0] ?? [], new Set(refs), (e) => said.get(e) ?? "").map(
      (e) => e.text
    );
  expect(of(["person:2"])).toEqual(["m0", "m2"]);
  expect(of(["person:7"])).toEqual([]);
});

test("a persona in an older shape reads as none, so it is due at the next run (no migration)", async () => {
  const ref = "person:older-shape";
  await Bun.write(
    personaPath(ref),
    JSON.stringify({
      built: "2026-11-08T00:00:00.000Z",
      inputs: "a",
      lines: [],
      madeBy: {},
      page: ref,
      schemaVersion: 1,
    })
  );
  try {
    expect(readPersona(ref)).toBeNull();
    expect(
      isDue(readPersona(ref), "a", new Date("2026-11-09T00:00:00.000Z"))
    ).toBe(true);
  } finally {
    rmSync(personaPath(ref));
  }
});

test("an old chapter is read by its words while lifelog holds its turns, by its summary when not", async () => {
  const server = lifelogServer({
    "/transcription-jobs/job-1/transcript": () => ({
      turns: [
        { speakerId: "speaker_0", text: "Allo" },
        { speakerId: "speaker_1", text: "Salut" },
      ],
    }),
  });
  const store = lifelogStore();
  apply(
    store,
    pageFixture({
      conversations: [conversation("c1")],
      turns: [
        turnFixture(0, "2026-10-14T10:00:00.000Z", null, null, "c1", true),
        turnFixture(1, "2026-10-14T10:01:00.000Z", "p1", "Plumber"),
      ],
    })
  );
  const chapter = (key: string, id: string) =>
    unitFixture({
      date: "2026-10-14",
      end: "2026-10-14T10:05:00.000Z",
      id,
      key,
      people: ["unknown:Plumber"],
      start: "2026-10-14T10:00:00.000Z",
      summary: "They talked about the sink.",
      title: "Sink",
    });
  try {
    const { days, recorded } = await spokenOf(
      recordingsOf(
        [chapter("c1", "heard"), chapter("gone", "gone")],
        new Set(["unknown:Plumber"])
      ),
      new Set(["unknown:Plumber"]),
      { resolve: () => null, truth: { people: [] } as unknown as Truth },
      () => "the plumber",
      10_000,
      () => store
    );
    expect(days.map((d) => d.messages.map((m) => m.text))).toEqual([
      ["Allo", "Salut"],
    ]);
    expect(recorded).toEqual([
      {
        day: "2026-10-14",
        summary: "They talked about the sink.",
        title: "Sink",
      },
    ]);
  } finally {
    server.close();
  }
});

test("a persona's window is 3 years ending at the newest day of all four lists, so the clock alone changes nothing", () => {
  const direct = [
    msg("2020-01-05", 0, false, "too old"),
    msg("2021-06-01", 0, false, "inside"),
    msg("2024-02-01", 0, true, "newest"),
  ];
  const days = (events: SourceEvent[], kind: "direct" | "own_writing") =>
    shownDaysOf(events, kind, whoOf, () => "Ana");
  const lists = (writing: SourceEvent[] = []) => ({
    groups: [],
    recordings: [],
    writing: days(writing, "own_writing"),
    written: days(direct, "direct"),
  });
  const digest = (writing: SourceEvent[] = []) => {
    const t = personaWindowOf(lists(writing));
    return inputsOf(
      "p",
      personaShownOf({ ...t, ref: "person:ana" }, direct, "Ana", 100_000).shown
    );
  };
  // Nothing in the window reads today: the same lists, the same digest, on any day.
  expect(personaWindowOf(lists()).written.map((d) => d.day)).toEqual([
    "2021-06-01",
    "2024-02-01",
  ]);
  const base = digest();
  expect(digest()).toBe(base);
  // The counts are over the windowed messages only.
  const {
    shown: { counts },
  } = personaShownOf(
    { ...personaWindowOf(lists()), ref: "person:ana" },
    direct,
    "Ana",
    100_000
  );
  expect(counts).toEqual(pairCountsOf(exchangeCountsOf(direct.slice(1))));
  expect(counts).not.toEqual(pairCountsOf(exchangeCountsOf(direct)));
  // A newer day in any list moves the window and changes the digest: here his own writing, two years on.
  const later = [msg("2026-03-01", 0, true, "his note", { chat: "notes" })];
  expect(personaWindowOf(lists(later)).written.map((d) => d.day)).toEqual([
    "2024-02-01",
  ]);
  expect(digest(later)).not.toBe(base);
});
