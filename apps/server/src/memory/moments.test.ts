import { expect, test } from "bun:test";
import type { Moment } from "../records/moments";
import type { Correction } from "../records/observations";
import type { MemoryLabel, Unit, Verdict } from "../records/units";
import { ledger, madeBy, unit, verdict } from "./fixtures";
import { daysOf, momentsNow } from "./ledger";
import {
  agreement,
  chatAreas,
  earlierFor,
  fresh,
  parseDay,
  unread,
} from "./moments";
import type { Truth } from "./truth";
import { areaLookup, type Built } from "./units";

const built = (id: string, over: Parameters<typeof unit>[0] = {}): Built => ({
  messages: [],
  text: "",
  unit: unit({ date: "2026-10-15", id, ...over }),
});
const U1 = "u_000000000001";
const U2 = "u_000000000002";
const U3 = "u_000000000003";

const moment = (over: Partial<Moment> = {}): Moment => ({
  copies: [],
  day: "2026-10-15",
  end: null,
  id: "mom_000000000001",
  importance: 2,
  madeBy,
  people: [{ ref: "person:bastien", role: "with" }],
  place: null,
  schemaVersion: 1,
  start: "2026-10-16",
  status: "planned",
  title: "Trip to see the sisters with Bastien",
  units: [U1],
  why: "w",
  ...over,
});

test("a day's reply is checked: verdicts and moments for its own units only, people from the map, ids kept or minted", () => {
  const u1 = unit({ id: U1 });
  const commits = unit({ id: U2, source: "git" });
  const ctx = {
    areas: areaLookup([{ id: "shop", name: "Shop" }]),
    day: "2026-10-15",
    earlier: new Set(["mom_00000000000e"]),
    madeBy,
    people: new Set(["person:bastien"]),
    resolve: (s: string) => (s === "Bast" ? "person:bastien" : null),
    units: new Map([
      [U1, u1],
      [U2, commits],
    ]),
  };
  const said = {
    importance: 2,
    people: [
      { ref: "person:me", role: "with" },
      { ref: "unknown:Bast", role: "with" },
      { ref: "unknown:Cédric", role: "with" },
      { ref: "person:invented", role: "with" },
    ],
    start: "2026-10-16 15:00",
    status: "planned",
    title: "Trip with Bastien",
    why: "w",
  };
  const v = { reason: "r", salience: 3, type: "todo" };
  const day = parseDay(
    {
      moments: [
        { ...said, end: "tomorrow", id: "new", units: [U2, U1, U3] },
        { ...said, id: "new", title: "Same units", units: [U1, U2] },
        { ...said, id: "mom_00000000000e", units: [U1] },
        { ...said, id: "new", units: [U3] },
        { ...said, id: "new", status: "maybe", units: [U1] },
      ],
      verdicts: [
        { ...v, area: "SHOP", id: U1, topics: ["Houses"], when: "2026-10-22" },
        { ...v, id: U1 },
        { ...v, id: U2 },
        { ...v, id: U3 },
        { ...v, id: U1, salience: 7 },
      ],
    },
    ctx
  );
  expect(day.verdicts).toEqual([
    {
      area: "shop",
      hash: u1.hash,
      madeBy,
      reason: "r",
      salience: 3,
      schemaVersion: 1,
      topics: ["house"],
      type: "todo",
      unit: U1,
      when: "2026-10-22",
    },
    // Commits are never read in full, whatever the model said.
    expect.objectContaining({ salience: 1, unit: U2 }),
  ]);
  // A unit he marked "hey Life" is read whatever the model said.
  const marked = unit({ id: U3, marked: ["j:1@a"] });
  expect(
    parseDay(
      { verdicts: [{ ...v, id: U3, salience: 0 }] },
      { ...ctx, units: new Map([[U3, marked]]) }
    ).verdicts.map((x) => x.salience)
  ).toEqual([3]);
  expect(day.invalid).toBe(3);
  expect(day.moments).toHaveLength(3);
  const [first, twin, again] = day.moments;
  expect(first?.units).toEqual([U2, U1]);
  expect(first?.end).toBeNull();
  expect(first?.people).toEqual([
    { ref: "person:bastien", role: "with" },
    { ref: "unknown:Cédric", role: "with" },
  ]);
  // Two moments on the same units stay two; the same reply mints the same ids on every run.
  expect(twin?.id).not.toBe(first?.id);
  expect(again?.id).toBe("mom_00000000000e");
  expect(
    parseDay({ moments: [{ ...said, id: "new", units: [U1, U2] }] }, ctx)
      .moments[0]?.id
  ).toBe(first?.id);
  expect(() => parseDay({ moments: 3 }, ctx)).toThrow();
});

test("the next days see a moment until the day after it ends, or after its date for a plan; the latest day's line is current", () => {
  const lines = [
    moment(),
    moment({
      day: "2026-10-12",
      id: "mom_000000000002",
      start: "2026-10-12 09:00",
      status: "happened",
    }),
    moment({
      day: "2026-10-14",
      id: "mom_000000000003",
      start: "2026-10-14 20:00",
      status: "happened",
    }),
  ];
  // The 15th sees the 14th's dinner, and its own plan from an earlier reading of it.
  expect(earlierFor("2026-10-15", lines, []).map((m) => m.id)).toEqual([
    "mom_000000000001",
    "mom_000000000003",
  ]);
  expect(earlierFor("2026-10-16", lines, []).map((m) => m.id)).toEqual([
    "mom_000000000001",
  ]);
  // A day read again sees its own moments, to keep their ids.
  expect(earlierFor("2026-10-14", lines, []).map((m) => m.id)).toContain(
    "mom_000000000003"
  );
  // Whatever it is dated.
  const back = moment({
    day: "2026-10-14",
    id: "mom_000000000004",
    start: "2026-10-10",
  });
  expect(
    earlierFor("2026-10-14", [...lines, back], []).map((m) => m.id)
  ).toContain("mom_000000000004");
  // A plan is not carried past the day after its date.
  expect(earlierFor("2026-10-18", lines, [])).toEqual([]);
  const later = moment({ day: "2026-10-16", status: "happened" });
  expect(
    momentsNow([...lines, later], []).find((m) => m.id === later.id)
  ).toEqual(later);
  // A moment the owner said is wrong is gone, from the reads and from what the next days see.
  const wrong: Correction = {
    at: "t",
    kind: "wrong",
    observations: ["mom_000000000001"],
    schemaVersion: 1,
  };
  expect(momentsNow(lines, [wrong]).map((m) => m.id)).not.toContain(
    "mom_000000000001"
  );
  expect(earlierFor("2026-10-16", lines, [wrong])).toEqual([]);
  expect(
    momentsNow(lines, [{ ...wrong, page: "person:bastien" }]).map((m) => m.id)
  ).not.toContain("mom_000000000001");
  // The days a moment covers: start to end, else its start, else the day that read it.
  expect(
    daysOf(moment({ end: "2026-10-17 06:00", start: "2026-10-15 18:00" }))
  ).toEqual(["2026-10-15", "2026-10-17"]);
  expect(daysOf(moment({ end: null, start: null }))).toEqual([
    "2026-10-15",
    "2026-10-15",
  ]);
});

test("a day is read again when one of its units has no verdict by this prompt on its current content", () => {
  const b = built(U1);
  expect(unread([b], ledger([]))).toBe(true);
  expect(
    unread(
      [b],
      ledger([
        verdict(b.unit, { madeBy: { ...madeBy, prompt: "memory-moments.v4" } }),
      ])
    )
  ).toBe(false);
  expect(unread([b], ledger([verdict(b.unit)]))).toBe(true);
  // Read again, the day keeps the verdict of a unit already judged on this content, and takes the others.
  const c = built(U2);
  const v2 = { ...madeBy, prompt: "memory-moments.v4" };
  const known = ledger([verdict(b.unit, { madeBy: v2 })]);
  const said = [
    verdict(b.unit, { madeBy: v2, salience: 0 }),
    verdict(c.unit, { madeBy: v2 }),
  ];
  expect(fresh(said, [b, c], known).map((v) => v.unit)).toEqual([U2]);
});

const HASH = "0000000000000000";
const AREA = "shop";
const unitOf = (id: string, drop?: string) =>
  unit({ drop, hash: HASH, id, source: "beeper" });
const judged = (
  u: Unit,
  type: Verdict["type"],
  salience: number,
  area: string | null = null
) => verdict(u, { area, madeBy, salience, type });

test("agreement: kept means salience 2+, code-rule drops count as skipped, labels of vanished units are only counted", () => {
  const [ua, ub, uc, ud, ue] = [
    "u_00000000000a",
    "u_00000000000b",
    "u_00000000000c",
    "u_00000000000d",
    "u_00000000000e",
  ].map((id) => unitOf(id, id.endsWith("d") ? "newsletter" : undefined)) as [
    Unit,
    Unit,
    Unit,
    Unit,
    Unit,
  ];
  const units = new Map([ua, ub, uc, ud, ue].map((u) => [u.id, u]));
  const verdicts = ledger([
    judged(ua, "todo", 3, AREA), // kept, matters
    judged(ub, "todo", 2), // kept, doesn't
    judged(uc, "nothing", 0), // skipped, matters
    // ud: dropped by a rule: skipped, doesn't
    judged(ue, "news", 2), // kept, matters
  ]);
  const labels: MemoryLabel[] = [
    { matters: true, unitId: "u_00000000000a" },
    { matters: false, unitId: "u_00000000000b" },
    { matters: true, unitId: "u_00000000000c" },
    { matters: false, unitId: "u_00000000000d" },
    { matters: true, unitId: "u_00000000000e" },
    { matters: true, unitId: "u_0000000000ff" },
  ];
  expect(agreement(labels, units, verdicts)).toEqual({
    agreement: 3 / 5,
    labeled: 5,
    missing: 1,
    precision: 2 / 3,
    recall: 2 / 3,
  });
});

test("a chat's area hint is the area of the projects that list it, by Beeper id and by WhatsApp id", () => {
  const truth = {
    chats: [
      { id: "!a:beeper.local", whatsapp: "1@g.us" },
      { id: "!b:beeper.local" },
    ],
    projects: [
      { area: "construction", chats: ["!a:beeper.local"] },
      { area: "family-money", chats: ["!a:beeper.local"] },
      { area: "shop", chats: [] },
    ],
  } as unknown as Truth;
  const hints = chatAreas(truth);
  expect(hints.get("!a:beeper.local")).toEqual([
    "construction",
    "family-money",
  ]);
  expect(hints.get("1@g.us")).toEqual(["construction", "family-money"]);
  expect(hints.has("!b:beeper.local")).toBe(false);
});
