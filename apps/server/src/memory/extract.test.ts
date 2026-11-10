import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import type { Observation } from "../records/observation";
import type { LifelogConversation } from "../sources/lifelog";
import {
  byDays,
  closedConversations,
  groupsOf,
  lanesOf,
  priorFor,
} from "./extract";
import { episodesNow } from "./ledger";
import { ledger, madeBy, unit, verdict } from "./record-fixtures";
import type { Built } from "./units";
import { episodeNow } from "./who";

const conversation = (id: string, closed: boolean): LifelogConversation => ({
  closed,
  endedAt: "2026-10-15T09:00:00.000Z",
  id,
  startedAt: "2026-10-15T08:00:00.000Z",
  title: "t",
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
    episodesNow(lines, [])
  );
  // An episode's commits are never read in full, whatever their importance.
  const commits = built("unit_000000000006", { source: "git" });
  expect(
    groupsOf(
      [b1],
      [b1, commits],
      ledger([verdict(b1.unit), verdict(commits.unit, { importance: 1 })]),
      episodesNow([episode({ units: [U1, "unit_000000000006"] })], [])
    ).groups.map((g) => g.units.map((b) => b.unit.id))
  ).toEqual([[U1]]);
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

test("an episode is read whole across its days: the 16 Oct ask goes with the 17 Oct reply (production's ep_fe3f0ff093bb), not with the bigger trip, the drive back or the same-day call", () => {
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
      episodesNow(lines, [])
    ).groups;
  // Only the reply is new: the ask, read on 16 Oct, is read again with it.
  const groups = read([reply]);
  expect(
    groups.map((g) => [
      g.episode?.id,
      g.episode?.title,
      g.units.map((b) => b.unit.id),
    ])
  ).toEqual([
    [
      pickup,
      "Pickup",
      [ask.unit.id, chapter.unit.id, reply.unit.id, drive.unit.id],
    ],
  ]);
  // A long episode is read from the day before its first pending unit: the trip's 12 Oct units wait.
  expect(read([trip[4] as Built]).map((g) => ids(g.units))).toEqual([
    ids(trip.slice(2)),
  ]);
});

test("earlier facts for an episode: its people's from two weeks before, Jean's own from its day and the day before, a fact retired from its own units again", () => {
  const o = (id: string, over: Partial<Observation>) =>
    ({
      at: `${over.date}T10:00:00.000Z`,
      entities: ["person:bastien"],
      id,
      madeBy: { ...madeBy, unitHash: "h" },
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
    { o: o("his", { date: "2026-10-14", entities: ["person:me"] }) },
    { o: o("his-old", { date: "2026-10-10", entities: ["person:me"] }) },
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
      entities: ["person:bastien"],
      id,
      madeBy: { ...madeBy, unitHash: "h" },
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
        entities: ["person:me"],
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
        entities: ["person:me"],
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
      entities: ["person:ann"],
      id: "ann-fact",
      madeBy: { ...madeBy, unitHash: "h" },
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
