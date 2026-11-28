import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import type { Extracted, Observation } from "../records/observation";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import type { VoiceConversation } from "../sources/voice-server";
import {
  byDays,
  closedConversations,
  continuedFrom,
  groupsOf,
  isReadable,
  lanesOf,
  ownContinued,
  priorFor,
  toExtract,
  unkeptOf,
} from "./extract";
import { episodesNow, isCurrent, standingReadings } from "./memory-files";
import { locate } from "./quote-check";
import { ledger, madeBy, unit, verdict } from "./record-fixtures";
import { type Built, linesHashOf, messageUnits } from "./units";
import { episodeNow } from "./who";

const conversation = (id: string, closed: boolean): VoiceConversation => ({
  closed,
  endedAt: "2026-10-15T09:00:00.000Z",
  id,
  startedAt: "2026-10-15T08:00:00.000Z",
  turns: [],
});

test("a conversation is closed when lifelog says it settled it, however long ago it ended", () => {
  const closed = closedConversations([
    conversation("settled", true),
    conversation("open", false),
  ]);
  expect([...closed]).toEqual(["settled"]);
});

const built = (id: string, over: Parameters<typeof unit>[0] = {}): Built => ({
  messages: [],
  text: "",
  unit: unit({ date: "2026-10-15", id, ...over }),
});
/** A unit is read unless it is one of `pending`. */
const unread = (pending: Built[]) => (b: Built) => !pending.includes(b);
const U1 = "unit_000000000001";
const U2 = "unit_000000000002";
const U3 = "unit_000000000003";
const U4 = "unit_000000000004";
const episode = (over: Partial<Episode> = {}): Episode => ({
  copies: [],
  day: "2026-10-15",
  end: null,
  id: "ep_000000000001",
  importance: 2,
  madeBy,
  people: [{ ref: "person:bastien", role: "with" }],
  place: null,
  schemaVersion: 1,
  start: "2026-10-16",
  title: "Trip to see the sisters with Bastien",
  units: [U1],
  what: "w",
  within: null,
  ...over,
});

test("extraction reads each unit once and no copy ever; pending units in no episode go last", () => {
  const all = [U1, U2, U3, U4].map((id) => built(id));
  const [b1, b2, b3, b4] = all as [Built, Built, Built, Built];
  const verdicts = ledger([
    verdict(b1.unit),
    verdict(b2.unit, { importance: 1 }),
    verdict(b3.unit),
    verdict(b4.unit, { importance: 0 }),
  ]);
  const lines = [
    episode({ start: "2026-10-15 18:00", units: [U1, U2, U4] }),
    episode({
      copies: [U3],
      id: "ep_000000000002",
      start: "2026-10-15 19:00",
      units: [U1, U3],
    }),
  ];
  const b5 = built("unit_000000000005");
  const { copies, groups } = groupsOf(
    [b1, b3, b5],
    [...all, b5],
    ledger([...verdicts.values(), verdict(b5.unit)]),
    episodesNow(lines, []),
    unread([b1, b3, b5])
  );
  // Activity stays out of extraction even when it makes an episode or has an inflated verdict.
  for (const source of ["git", "screen", "apple-health", "photos"] as const) {
    const activity = built("unit_000000000006", { source });
    expect(
      groupsOf(
        [b1],
        [b1, activity],
        ledger([verdict(b1.unit), verdict(activity.unit, { importance: 3 })]),
        episodesNow([episode({ units: [U1, activity.unit.id] })], []),
        unread([b1])
      ).groups.map((g) => g.units.map((b) => b.unit.id))
    ).toEqual([[U1]]);
  }
  // U3 is a copy: never read, even though pending; returned apart, to be marked read with nothing in it.
  expect(copies.map((b) => b.unit.id)).toEqual([U3]);
  expect(
    groups.map((g) => [g.episode?.id ?? null, g.units.map((b) => b.unit.id)])
  ).toEqual([
    // Both episodes reach 15 Oct: the smaller keeps U1, and the other holds nothing pending.
    ["ep_000000000002", [U1]],
    [null, ["unit_000000000005"]],
  ]);
});

test("the calls of one episode share a lane, in order, even when a call joins two episodes' lanes", () => {
  const of = (id: string | null) => ({
    episode: id ? episode({ id: `ep_00000000000${id}` }) : null,
  });
  const a1 = [of("a")];
  const b1 = [of("b")];
  const ab2 = [of("a"), of("b")];
  const c1 = [of("c")];
  const none = [of(null)];
  expect(lanesOf([a1, b1, c1, ab2, none])).toEqual([
    [a1, b1, ab2],
    [c1],
    [none],
  ]);
});

test("a group over the budget is cut between its days, never within one", () => {
  const days = ["12", "12", "13", "14"].map((d, n) =>
    built(`unit_00000000000${n}`, { date: `2026-10-${d}` })
  );
  const sources = days.map((b) => ({
    lines: [{ at: "", ref: "", speaker: "", text: "x".repeat(40) }],
    unit: b.unit,
  }));
  const ids = (g: { units: Built[] }) => g.units.map((b) => b.unit.id);
  expect(
    byDays({ episode: episode(), sources, units: days }, 100).map(ids)
  ).toEqual([ids({ units: days.slice(0, 2) }), ids({ units: days.slice(2) })]);
  expect(byDays({ episode: null, sources, units: days }, 1000)).toHaveLength(1);
});

test("an episode holds only its units not read yet: the 17 Oct reply (production's ep_fe3f0ff093bb) without its 16 Oct ask, the trip or the drive back", () => {
  const ask = built("unit_e0b92ec800e1", { date: "2026-10-16" });
  const chapter = built("unit_4eecb6d5777c", { date: "2026-10-16" });
  const reply = built("unit_0fdaf120134a", { date: "2026-10-17" });
  const drive = built("unit_6216b3012704", { date: "2026-10-17" });
  const trip = ["12", "12", "16", "16", "17", "17"].map((d, n) =>
    built(`unit_trip0000000${n}`, { date: `2026-10-${d}` })
  );
  const back = [1, 2, 3, 4].map((n) =>
    built(`unit_back0000000${n}`, { date: "2026-10-17" })
  );
  const all = [ask, chapter, reply, drive, ...trip, ...back];
  const ids = (bs: Built[]) => bs.map((b) => b.unit.id);
  const pickup = "ep_fe3f0ff093bb";
  const lines = [
    episode({
      day: "2026-10-16",
      id: pickup,
      units: ids([ask, chapter]),
    }),
    episode({
      day: "2026-10-17",
      id: pickup,
      title: "Pickup",
      units: ids([reply, drive]),
    }),
    episode({ day: "2026-10-16", id: "ep_383deb827705", units: ids([ask]) }),
    episode({
      day: "2026-10-17",
      id: "ep_5de28e122d75",
      units: ids([reply, ...back]),
    }),
    ...["12", "16", "17"].map((d) =>
      episode({
        day: `2026-10-${d}`,
        id: "ep_248b49671504",
        units: ids([
          ...(d === "16" ? [ask] : []),
          ...trip.filter((b) => b.unit.date.endsWith(d)),
        ]),
      })
    ),
  ];
  const read = (pending: Built[]) =>
    groupsOf(
      pending,
      all,
      ledger(all.map((b) => verdict(b.unit))),
      episodesNow(lines, []),
      unread(pending)
    ).groups;
  // Only the reply is new: the ask, read on 16 Oct, stays read and comes as earlier facts.
  const groups = read([reply]);
  expect(
    groups.map((g) => [
      g.episode?.id,
      g.episode?.title,
      g.units.map((b) => b.unit.id),
    ])
  ).toEqual([[pickup, "Pickup", [reply.unit.id]]]);
  // A new day of a long trip does not read the trip again: only its new unit goes in.
  expect(read([trip[4] as Built]).map((g) => ids(g.units))).toEqual([
    ids([trip[4] as Built]),
  ]);
  // An episode with two units read and one not: the group holds that one only.
  expect(read([drive]).map((g) => ids(g.units))).toEqual([ids([drive])]);
});

test("earlier facts for an episode: its people's from two weeks before, Jean's own from its day and the day before, a fact retired from its own units again", () => {
  const o = (id: string, over: Partial<Observation>) =>
    ({
      at: `${over.date}T10:00:00.000Z`,
      id,
      madeBy: { ...madeBy, unitHash: "h" },
      subjects: ["person:bastien"],
      unit: U4,
      ...over,
    }) as Observation;
  const group = {
    episode: episode(),
    units: [built(U1, { date: "2026-10-14" }), built(U2)],
  };
  const shown = [
    { o: o("old", { date: "2026-09-20" }) },
    { o: o("near", { date: "2026-10-14" }) },
    { o: o("own", { date: "2026-10-15", unit: U1 }) },
    { o: o("his", { date: "2026-10-14", subjects: ["person:me"] }) },
    { o: o("his-old", { date: "2026-10-10", subjects: ["person:me"] }) },
    { by: U1, o: o("retired-here", { date: "2026-10-13" }) },
    { by: U3, o: o("retired-elsewhere", { date: "2026-10-13" }) },
    { o: o("same", { date: "2026-10-15" }) },
    // Facts of a unit read again elsewhere in the run are about to be replaced: never shown; one it retired is.
    { o: o("crowding", { date: "2026-10-15", unit: U3 }) },
    { by: U3, o: o("retired-by-reread", { date: "2026-10-12" }) },
    // What this run already wrote for a unit it read is its reading now: shown, newest first.
    {
      o: o("written-now", {
        at: "2026-10-18T10:00:00.000Z",
        date: "2026-10-13",
        madeBy: { ...madeBy, run: "now", unitHash: "h" },
        unit: U3,
      }),
    },
  ];
  expect(
    priorFor(group, shown, new Set([U1, U2, U3]), "now", new Set()).map(
      (x) => x.id
    )
  ).toEqual([
    "written-now",
    "same",
    "near",
    "his",
    "retired-here",
    "retired-elsewhere",
    "retired-by-reread",
  ]);
  expect(
    priorFor(group, shown, new Set([U1, U2]), "now", new Set()).map((x) => x.id)
  ).toEqual(["written-now", "same", "crowding", "near", "his", "retired-here"]);
  // Someone close: what is between them is shown from up to a year back, after the recent facts.
  const bond = [
    ...shown,
    { o: o("bond", { date: "2026-03-01", type: "about_a_person" }) },
    { o: o("bond-too-old", { date: "2025-09-01", type: "about_a_person" }) },
  ];
  expect(
    priorFor(group, bond, new Set([U1, U2]), "now", new Set(["person:bastien"]))
      .map((x) => x.id)
      .at(-1)
  ).toBe("bond");
  expect(
    priorFor(group, bond, new Set([U1, U2]), "now", new Set()).map((x) => x.id)
  ).not.toContain("bond");
});

test("earlier facts also hold the episode's own units at any age, in their own slot; another episode's older facts stay out", () => {
  const o = (id: string, over: Partial<Observation>) =>
    ({
      at: `${over.date}T10:00:00.000Z`,
      id,
      madeBy: { ...madeBy, unitHash: "h" },
      subjects: ["person:bastien"],
      type: "choice",
      unit: U3,
      ...over,
    }) as Observation;
  const group = {
    episode: episode({ units: [U1, U4] }),
    units: [built(U1, { date: "2026-10-15" })],
  };
  const shown = [
    // From the episode's own earlier unit, 20 days back: any type, his own too.
    { o: o("plan", { date: "2026-09-25", type: "to_do", unit: U4 }) },
    {
      o: o("his-plan", {
        date: "2026-09-25",
        subjects: ["person:me"],
        unit: U4,
      }),
    },
    // From another episode, older than two weeks: none, an open loop neither.
    { o: o("owed", { date: "2026-09-25", type: "waiting_on_someone" }) },
    { o: o("decided", { date: "2026-09-25" }) },
    { o: o("too-old", { date: "2026-08-10", type: "promise" }) },
    {
      o: o("his-loop", {
        date: "2026-09-25",
        subjects: ["person:me"],
        type: "to_do",
      }),
    },
    // Recent facts never crowd the slot out.
    ...Array.from({ length: 3 }, (_, k) => ({
      o: o(`recent-${k}`, { date: "2026-10-14" }),
    })),
  ];
  expect(
    priorFor(group, shown, new Set([U1]), "now", new Set(), 2).map((x) => x.id)
  ).toEqual(["recent-0", "recent-1", "plan", "his-plan"]);
});

test("an episode read with a person folded since (`episodeNow`) offers that person's earlier facts", () => {
  const fact = {
    o: {
      at: "2026-10-14T10:00:00.000Z",
      date: "2026-10-14",
      id: "ann-fact",
      madeBy: { ...madeBy, unitHash: "h" },
      subjects: ["person:ann"],
      unit: U4,
    } as Observation,
  };
  const stored = episode({ people: [{ ref: "person:inf_ann", role: "with" }] });
  const fold = (ref: string) => (ref === "person:inf_ann" ? "person:ann" : ref);
  const prior = (m: Episode) =>
    priorFor(
      { episode: m, units: [built(U1)] },
      [fact],
      new Set([U1]),
      "now",
      new Set()
    ).map((x) => x.id);
  expect(prior(stored)).toEqual([]);
  expect(prior(episodeNow(stored, fold))).toEqual(["ann-fact"]);
});

/** A chat unit of `texts`, as it stood when it held that many messages: its hash is the one `chatDay` gives. */
const chat = (id: string, texts: string[]): Built => {
  const messages = texts.map((text, n) => ({
    at: `2026-10-15T0${n}:00:00.000Z`,
    fromMe: n % 2 === 0,
    id: `${id}-m${n}`,
    known: true,
    sender: "someone",
    text,
  }));
  const b = { messages, text: "", unit: unit({ id, source: "imessage" }) };
  return { ...b, unit: { ...b.unit, hash: linesHashOf(b, messages.length) } };
};
const words = ["a", "b", "c", "d", "e", "f", "g"];
/** The line a night writes for `b` as it stands, `continues` when it continued an earlier one. */
const read = (b: Built, over: Partial<Extracted> = {}): Extracted => ({
  at: "2026-10-15T20:00:00.000Z",
  lines: b.messages.length,
  observations: 1,
  prompt: "memory-extract.v8",
  run: "r1",
  schemaVersion: 1,
  unit: b.unit.id,
  unitHash: b.unit.hash,
  ...over,
});
const none = new Map<string, string>();

test("a chat read at 4 messages and grown to 7 is continued from 4; an edited earlier message, a voice, an old line or another prompt reads whole", () => {
  const four = chat(U1, words.slice(0, 4));
  const seven = chat(U1, words);
  const from = (b: Built, lines: Extracted[], prompt?: string) =>
    continuedFrom(b, standingReadings(lines), none, prompt);
  expect(from(seven, [read(four)])).toBe(4);
  // Not grown: nothing to continue.
  expect(from(four, [read(four)])).toBe(0);
  // Message 2 edited: its first four lines are no longer what was read.
  expect(from(chat(U1, ["a", "B", ...words.slice(2)]), [read(four)])).toBe(0);
  // A line before `lines` existed: it cannot be continued.
  expect(from(seven, [{ ...read(four), lines: undefined }])).toBe(0);
  expect(from(seven, [read(four, { prompt: "memory-extract.v5" })])).toBe(0);
  expect(from(seven, [read(four, { unkept: true })])).toBe(0);
  // His word that it was read wrong, after the reading.
  expect(
    continuedFrom(
      seven,
      standingReadings([read(four)]),
      new Map([[U1, "2026-10-16T00:00:00.000Z"]])
    )
  ).toBe(0);
  // A note (or an import, a repo day) grows like a chat but is read whole: only a chat or mail continues.
  const note = (b: Built): Built => ({
    ...b,
    unit: { ...b.unit, source: "notes" },
  });
  expect(from(note(seven), [read(note(four))])).toBe(0);
  // A voice unit (no messages) is read whole.
  expect(from(built(U1), [read(built(U1), { lines: undefined })])).toBe(0);
  // A chain: read at 4, continued to 7, then to 9 from 7.
  const nine = chat(U1, [...words, "h", "i"]);
  expect(
    from(nine, [read(four), read(seven, { continues: true, run: "r2" })])
  ).toBe(7);
});

test("a file described before its unit's first read lets it be continued; one described after makes it read whole once", () => {
  const tag = "[photo IMG.HEIC, not on this Mac]";
  const done = "[photo IMG.HEIC, described by Life: a beach]";
  const stood = (photo: string) => chat(U1, ["a", photo, "c"]);
  const grown = (photo: string) => chat(U1, ["a", photo, "c", "d"]);
  const standing = (b: Built) => standingReadings([read(b)]);
  expect(continuedFrom(grown(done), standing(stood(done)), none)).toBe(3);
  expect(continuedFrom(grown(done), standing(stood(tag)), none)).toBe(0);
});

test("a unit whose earlier line changed is read whole and its unchanged sibling in the same run is continued", () => {
  const stood = [chat(U1, ["a", "b", "c"]), chat(U2, ["x", "y", "z"])];
  const grown = [
    chat(U1, ["a", "b", "c", "d"]),
    chat(U2, ["x", "Y", "z", "w"]),
  ];
  const standing = standingReadings(stood.map((b) => read(b)));
  expect(grown.map((b) => continuedFrom(b, standing, none))).toEqual([3, 0]);
});

test("a continued unit's facts are all shown as earlier facts, never cut by the episode's slot", () => {
  const shown = Array.from({ length: 25 }, (_, k) => ({
    o: {
      at: `2026-09-01T10:${String(k).padStart(2, "0")}:00.000Z`,
      date: "2026-09-01",
      id: `fact-${k}`,
      madeBy: { ...madeBy, unitHash: "h" },
      subjects: ["person:bastien"],
      type: "choice",
      unit: U4,
    } as Observation,
  }));
  const group = {
    episode: episode({ units: [U1, U4] }),
    units: [built(U1, { date: "2026-10-15" })],
  };
  const count = (continued: string[]) =>
    priorFor(group, shown, new Set(), "now", new Set(), 0, new Set(continued))
      .length;
  expect(count([])).toBe(20);
  expect(count([U4])).toBe(25);
});

test("a call shows the facts of its own continued units only, not those of another group's", () => {
  const shown = Array.from({ length: 25 }, (_, k) => ({
    o: {
      at: `2026-09-01T10:${String(k).padStart(2, "0")}:00.000Z`,
      date: "2026-09-01",
      id: `fact-${k}`,
      madeBy: { ...madeBy, unitHash: "h" },
      subjects: ["person:bastien"],
      type: "choice",
      unit: U4,
    } as Observation,
  }));
  const continued = new Map([[U4, 3]]);
  const holding = { episode: episode({ units: [U4] }), units: [built(U4)] };
  const other = { episode: episode({ units: [U1] }), units: [built(U1)] };
  const count = (g: typeof holding) =>
    priorFor(
      g,
      shown,
      new Set(),
      "now",
      new Set(),
      0,
      ownContinued(g, continued)
    ).length;
  expect(count(holding)).toBe(25);
  expect(count(other)).toBe(0);
});

test("a demoted unit gets one outcome: read when a call holds it, else unkept, an empty transcript too", () => {
  const [b1, b2] = [U1, U2].map((id) => built(id)) as [Built, Built];
  const call = (...bs: Built[]) => [
    [{ sources: bs.map((b) => ({ lines: [], unit: b.unit })) }],
  ];
  expect(unkeptOf([b2], call(b1, b2))).toEqual([]);
  // Grouped with its episode, but its lines came back empty: in no call.
  expect(unkeptOf([b2], call(b1))).toEqual([b2]);
});

test("a chat of today is read at once; an open lifelog conversation of today waits for its closing", () => {
  const today = "2026-10-16";
  const closed = new Set(["closed-key"]);
  const day = (over: Parameters<typeof unit>[0]) => built(U1, over);
  expect(
    isReadable(day({ date: today, source: "imessage" }), today, closed)
  ).toBe(true);
  expect(
    isReadable(
      day({ date: today, key: "open-key", source: "voice" }),
      today,
      closed
    )
  ).toBe(false);
  expect(
    isReadable(
      day({ date: today, key: "closed-key", source: "voice" }),
      today,
      closed
    )
  ).toBe(true);
  expect(
    isReadable(
      day({ date: "2026-10-15", key: "open-key", source: "voice" }),
      today,
      closed
    )
  ).toBe(true);
});

test("a chat unit's hash is the hash of its first messages as they were: what a later reading continues from", () => {
  const msg = (n: number): SourceEvent => ({
    at: `2026-10-09T10:0${n}:00.000Z`,
    chat: "!chat:matrix",
    chatName: "Dad",
    fromMe: n % 2 === 0,
    id: `m${n}`,
    sender: "+33600000002",
    source: "line",
    text: `Message ${n}`,
  });
  const of = (n: number) =>
    messageUnits([0, 1, 2].slice(0, n).map(msg), () => null)[0] as Built;
  expect(of(3).unit.hash).not.toBe(of(2).unit.hash);
  expect(linesHashOf(of(3), 2)).toBe(of(2).unit.hash);
  expect(linesHashOf(of(3), 3)).toBe(of(3).unit.hash);
});

test("a continued unit's quote is looked for from its first new line, where the hint is missing", () => {
  // A line repeated before and after `from`: with the model's hint the new one is kept; with none, the search
  // starts at `from`, so the quote no longer lands on its first occurrence (which would drop the fact as a repeat).
  const lines = [
    "d'accord ok pour demain",
    "autre chose",
    "d'accord ok pour demain",
  ];
  expect(locate("d'accord ok pour demain", lines, 2, 1)?.line).toBe(2);
  expect(locate("d'accord ok pour demain", lines, undefined, 1)?.line).toBe(2);
  expect(locate("d'accord ok pour demain", lines)?.line).toBe(0);
  // Said only before `from`: still found, then dropped as a repeat.
  expect(
    locate("autre chose", ["autre chose", "x", "y"], undefined, 2)?.line
  ).toBe(0);
});

const bare = (u: Unit): Built => ({ messages: [], text: "", unit: u });
test("the cache: a unit is read again only when its content or the prompt changed", () => {
  const a = unit({ id: "unit_00000000000a" });
  const b = unit({ id: "unit_00000000000b" });
  const c = unit({ id: "unit_00000000000c" });
  const d = unit({ hash: "ffffffffffffffff", id: "unit_00000000000d" });
  const e = unit({ id: "unit_00000000000e" });
  const verdicts = ledger([
    verdict(a, { importance: 2 }),
    verdict(b, { importance: 0 }),
    verdict(c, { importance: 3 }),
    // Judged on older content.
    verdict(d, { hash: "0123456789abcdef", importance: 3 }),
    // Importance 1: searchable, never read in full.
    verdict(e, { importance: 1 }),
  ]);
  const extracted = [
    {
      at: "2026-10-10T02:00:00.000Z",
      observations: 2,
      prompt: "memory-extract.v1",
      run: "r0",
      schemaVersion: 1 as const,
      unit: c.id,
      unitHash: c.hash,
    },
  ];
  const r = toExtract(
    [a, b, c, d, e].map(bare),
    verdicts,
    standingReadings(extracted),
    "memory-extract.v1"
  );
  expect(r.kept.map((k) => k.b.unit.id)).toEqual([a.id, c.id]);
  expect(r.pending.map((k) => k.b.unit.id)).toEqual([a.id]);
  expect(r.stale).toBe(1);
  expect(
    toExtract(
      [c].map(bare),
      verdicts,
      standingReadings(extracted),
      "memory-extract.v2"
    ).pending
  ).toHaveLength(1);
});

test("a unit with a confirmed arrival is read whatever its verdict, even one cached before the confirm", () => {
  const light = unit({ id: "unit_0000000000aa" });
  const verdicts = ledger([verdict(light, { importance: 0 })]);
  expect(toExtract([bare(light)], verdicts, new Map()).pending).toHaveLength(0);
  expect(
    toExtract(
      [bare(light)],
      verdicts,
      new Map(),
      undefined,
      undefined,
      new Set([light.id])
    ).pending
  ).toHaveLength(1);
});

test("a unit he said was read wrong is read again, once: his word against its last reading, as instants", () => {
  const sam = unit({ id: "unit_00000000001a", people: ["person:lou"] });
  const verdicts = ledger([verdict(sam, { importance: 3 })]);
  const readLine = (at = "2026-10-10T02:00:00.000Z") => ({
    at,
    observations: 1,
    prompt: "memory-extract.v1",
    run: "r0",
    schemaVersion: 1 as const,
    unit: sam.id,
    unitHash: sam.hash,
  });
  const pending = (
    lines: ReturnType<typeof readLine>[],
    rereads: [string, string][] = []
  ) =>
    toExtract(
      [bare(sam)],
      verdicts,
      standingReadings(lines),
      "memory-extract.v1",
      new Map(rereads)
    ).pending.length;
  expect(pending([readLine()])).toBe(0);
  expect(pending([readLine()], [[sam.id, "2026-10-21T00:00:00.000Z"]])).toBe(1);
  expect(
    pending(
      [readLine(), readLine("2026-10-22T02:00:00.000Z")],
      [[sam.id, "2026-10-21T00:00:00.000Z"]]
    )
  ).toBe(0);
  // 04:00+02:00 is 02:00Z: the same instant as the reading, so it is settled.
  expect(
    pending(
      [readLine("2026-10-22T02:00:00.000Z")],
      [[sam.id, "2026-10-22T04:00:00+02:00"]]
    )
  ).toBe(0);
});

test("a unit read before and no longer kept is unkept once (its facts replaced by none), and read again when kept again", () => {
  const lou = unit({ id: "unit_00000000002b", people: ["person:lou"] });
  const line = (observations: number, at: string, unkept?: true) => ({
    at,
    observations,
    prompt: "memory-extract.v1",
    run: at,
    schemaVersion: 1 as const,
    unit: lou.id,
    unitHash: lou.hash,
    ...(unkept ? { unkept } : {}),
  });
  const run = (
    importance: number,
    lines: ReturnType<typeof line>[],
    rereads: [string, string][] = []
  ) =>
    toExtract(
      [bare(lou)],
      ledger([verdict(lou, { importance })]),
      standingReadings(lines),
      "memory-extract.v1",
      new Map(rereads)
    );
  const firstRead = line(3, "2026-10-10T02:00:00.000Z");
  const reread: [string, string][] = [[lou.id, "2026-10-21T00:00:00.000Z"]];
  const emptied = line(0, "2026-10-22T02:00:00.000Z", true);
  // Never read: nothing to replace.
  expect(run(1, []).demoted).toHaveLength(0);
  // Read, then re-read and judged lower: unkept.
  expect(run(1, [firstRead], reread).demoted).toHaveLength(1);
  // Its unkept line written: settled.
  expect(run(1, [firstRead, emptied], reread).demoted).toHaveLength(0);
  // Kept again on the same content: read again, its unkept line being no reading.
  expect(run(3, [firstRead, emptied], reread).pending).toHaveLength(1);
  // A fact of the earlier reading is no longer current once the unkept line is the latest.
  const fact = {
    madeBy: { run: firstRead.run, unitHash: lou.hash },
    unit: lou.id,
  };
  const statusInputs = (lines: ReturnType<typeof line>[]) => ({
    live: new Set([lou.id]),
    standing: standingReadings(lines),
  });
  expect(isCurrent(statusInputs([firstRead]), fact as Observation)).toBe(true);
  expect(
    isCurrent(statusInputs([firstRead, emptied]), fact as Observation)
  ).toBe(false);
});

test("a chat whose content changed back to what an earlier reading read is read again: the cache is the reading its facts stand on", () => {
  const a = unit({ id: "unit_00000000003c", source: "imessage" });
  const ab = { ...a, hash: "fedcba9876543210" };
  const reading = (u: Unit, run: string, at: string) => ({
    at,
    lines: u === a ? 1 : 2,
    observations: 1,
    prompt: "memory-extract.v1",
    run,
    schemaVersion: 1 as const,
    unit: u.id,
    unitHash: u.hash,
  });
  const standing = standingReadings([
    reading(a, "r1", "2026-10-10T02:00:00.000Z"),
    reading(ab, "r2", "2026-10-11T02:00:00.000Z"),
  ]);
  const verdicts = ledger([
    verdict(a, { importance: 3 }),
    verdict(ab, { importance: 3 }),
  ]);
  expect(
    toExtract([bare(a)], verdicts, standing, "memory-extract.v1").pending
  ).toHaveLength(1);
  expect(
    toExtract([bare(ab)], verdicts, standing, "memory-extract.v1").pending
  ).toHaveLength(0);
});
