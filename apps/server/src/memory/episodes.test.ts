import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import type { Correction } from "../records/observation";
import type { MemoryLabel, Unit, Verdict } from "../records/unit";
import {
  agreement,
  chatAreas,
  dayFileOf,
  EPISODES_PROMPT,
  earlierFor,
  fresh,
  parseDay,
  unread,
} from "./episodes";
import { daysOf, episodesNow, isRereadSince, rereadAt } from "./ledger";
import type { Truth } from "./read-truth";
import { ledger, madeBy, unit, verdict } from "./record-fixtures";
import { areaLookup } from "./tags";
import type { Built } from "./units";

const built = (id: string, over: Parameters<typeof unit>[0] = {}): Built => ({
  messages: [],
  text: "",
  unit: unit({ date: "2026-10-15", id, ...over }),
});
const U1 = "unit_000000000001";
const U2 = "unit_000000000002";
const U3 = "unit_000000000003";

const episode = (over: Partial<Episode> = {}): Episode => ({
  copies: [],
  day: "2026-10-15",
  end: null,
  id: "ep_000000000001",
  importance: 2,
  madeBy: { ...madeBy, prompt: EPISODES_PROMPT },
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

test("a day's reply is checked: verdicts and episodes for its own units only, people from the map, ids kept or minted", () => {
  const u1 = unit({ id: U1 });
  const commits = unit({ id: U2, source: "git" });
  const ctx = {
    areas: areaLookup([{ id: "shop", name: "Shop" }]),
    day: "2026-10-15",
    earlier: new Set(["ep_00000000000e", "ep_00000000000f"]),
    hidden: new Set(["ep_00000000000f"]),
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
    title: "Trip with Bastien",
    what: "w",
  };
  const v = { importance: 3, reason: "r", type: "to_do" };
  const day = parseDay(
    {
      episodes: [
        { ...said, end: "tomorrow", id: "new", units: [U2, U1, U3] },
        { ...said, id: "new", title: "Same units", units: [U1, U2] },
        { ...said, id: "ep_00000000000e", units: [U1] },
        { ...said, id: "new", units: [U3] },
        { ...said, id: "new", units: [U1], what: 3 },
        // Only his agents' commits: never an episode alone.
        { ...said, id: "new", units: [U2] },
      ],
      verdicts: [
        { ...v, area: "SHOP", id: U1, topics: ["Houses"], when: "2026-10-22" },
        { ...v, id: U1 },
        { ...v, id: U2 },
        { ...v, id: U3 },
        { ...v, id: U1, importance: 7 },
      ],
    },
    ctx
  );
  expect(day.verdicts).toEqual([
    {
      area: "shop",
      hash: u1.hash,
      importance: 3,
      madeBy,
      reason: "r",
      schemaVersion: 1,
      topics: ["house"],
      type: "to_do",
      unit: U1,
      when: "2026-10-22",
    },
    // Commits are never read in full, whatever the model said.
    expect.objectContaining({ importance: 1, unit: U2 }),
  ]);
  // A unit he marked is read whatever the model said, but a mark keeps, it never weighs (8 Nov 2026).
  const marked = unit({ id: U3, marked: ["j:1@a"] });
  const weighed = (importance: number) =>
    parseDay(
      { verdicts: [{ ...v, id: U3, importance }] },
      { ...ctx, units: new Map([[U3, marked]]) }
    ).verdicts.map((x) => x.importance);
  expect(weighed(0)).toEqual([2]);
  expect(weighed(3)).toEqual([3]);
  expect(day.invalid).toBe(3);
  expect(day.episodes).toHaveLength(3);
  const [first, twin, again] = day.episodes;
  expect(first?.units).toEqual([U2, U1]);
  expect(first?.end).toBeNull();
  expect(first?.people).toEqual([
    { ref: "person:bastien", role: "with" },
    { ref: "unknown:Cédric", role: "with" },
  ]);
  // Two episodes on the same units stay two; the same reply mints the same ids on every run.
  expect(twin?.id).not.toBe(first?.id);
  expect(again?.id).toBe("ep_00000000000e");
  expect(
    parseDay({ episodes: [{ ...said, id: "new", units: [U1, U2] }] }, ctx)
      .episodes[0]?.id
  ).toBe(first?.id);
  expect(() => parseDay({ episodes: 3 }, ctx)).toThrow();
  // `within` names the reply's own id or an earlier episode, else nothing; `gone` only this day's episodes he did not hide.
  const nested = parseDay(
    {
      episodes: [
        { ...said, id: "new-1", title: "Trip", units: [U1, U3] },
        { ...said, id: "new-2", units: [U1], within: "new-1" },
        {
          ...said,
          id: "new-3",
          title: "Lunch",
          units: [U3],
          within: "ep_00000000000e",
        },
        { ...said, id: "new-4", title: "Coffee", units: [U3], within: "new-9" },
      ],
      gone: ["ep_00000000000e", "ep_00000000000f", "ep_000000000099", 4],
    },
    { ...ctx, units: new Map([...ctx.units, [U3, unit({ id: U3 })]]) }
  );
  const [trip, inTrip, lunch, coffee] = nested.episodes;
  expect(inTrip?.within).toBe(trip?.id as string);
  expect(lunch?.within).toBe("ep_00000000000e");
  expect(coffee?.within).toBeNull();
  expect(nested.gone).toEqual(["ep_00000000000e"]);
  // An episode read again after he hid it stands on the same day, start and units: it never takes the hidden one's id,
  // unless the model reuses that id on purpose (a not-important one stays hidden).
  const readAgain = { ...said, id: "new", units: [U1] };
  const minted = parseDay({ episodes: [readAgain] }, ctx).episodes[0]
    ?.id as string;
  const hidden = { ...ctx, hidden: new Set([minted]) };
  const titled = parseDay({ episodes: [readAgain] }, hidden).episodes[0]
    ?.id as string;
  expect(titled).not.toBe(minted);
  // Nor when its title's id is hidden too.
  const both = { ...ctx, hidden: new Set([minted, titled]) };
  expect([minted, titled]).not.toContain(
    parseDay({ episodes: [readAgain] }, both).episodes[0]?.id
  );
  expect(
    parseDay({ episodes: [{ ...readAgain, id: "ep_00000000000f" }] }, ctx)
      .episodes[0]?.id
  ).toBe("ep_00000000000f");
  // 29 Oct: the model put the recording kind in `type` for 198 of a day's 370 units; each is kept, read as nothing.
  const kindAsType = parseDay(
    {
      verdicts: [
        {
          ...v,
          id: U1,
          importance: 2,
          kind: "conversation",
          type: "conversation",
        },
      ],
    },
    ctx
  );
  expect(kindAsType.invalid).toBe(0);
  expect(kindAsType.verdicts[0]).toMatchObject({
    importance: 2,
    kind: "conversation",
    type: "nothing",
  });
});

test("the next days see an episode until the day after it ends; the latest day's line is current; an older prompt's episode is not seen", () => {
  const lines = [
    episode(),
    episode({
      day: "2026-10-12",
      id: "ep_000000000002",
      start: "2026-10-12 09:00",
    }),
    episode({
      day: "2026-10-14",
      id: "ep_000000000003",
      start: "2026-10-14 20:00",
    }),
  ];
  // Under a new prompt the day is read as for the first time.
  const old = episode({ id: "ep_000000000005", madeBy });
  expect(
    earlierFor("2026-10-15", [...lines, old], []).map((m) => m.id)
  ).not.toContain(old.id);
  // The 15th sees the 14th's dinner, and its own episode from an earlier reading of it.
  expect(earlierFor("2026-10-15", lines, []).map((m) => m.id)).toEqual([
    "ep_000000000001",
    "ep_000000000003",
  ]);
  expect(earlierFor("2026-10-16", lines, []).map((m) => m.id)).toEqual([
    "ep_000000000001",
  ]);
  // A day read again sees its own episodes, to keep their ids.
  expect(earlierFor("2026-10-14", lines, []).map((m) => m.id)).toContain(
    "ep_000000000003"
  );
  // Whatever it is dated.
  const back = episode({
    day: "2026-10-14",
    id: "ep_000000000004",
    start: "2026-10-10",
  });
  expect(
    earlierFor("2026-10-14", [...lines, back], []).map((m) => m.id)
  ).toContain("ep_000000000004");
  // Not carried past the day after it ends.
  expect(earlierFor("2026-10-18", lines, [])).toEqual([]);
  const later = episode({ day: "2026-10-16" });
  expect(
    episodesNow([...lines, later], []).find((m) => m.id === later.id)
  ).toEqual(later);
  // An episode the owner said is wrong is gone, from the reads and from what the next days see.
  const wrong: Correction = {
    at: "t",
    kind: "wrong",
    observations: ["ep_000000000001"],
    schemaVersion: 1,
  };
  expect(episodesNow(lines, [wrong]).map((m) => m.id)).not.toContain(
    "ep_000000000001"
  );
  expect(earlierFor("2026-10-16", lines, [wrong])).toEqual([]);
  expect(
    episodesNow(lines, [{ ...wrong, page: "person:bastien" }]).map((m) => m.id)
  ).not.toContain("ep_000000000001");
  // The days an episode covers: start to end, else its start, else the day that read it.
  expect(
    daysOf(episode({ end: "2026-10-17 06:00", start: "2026-10-15 18:00" }))
  ).toEqual(["2026-10-15", "2026-10-17"]);
  expect(daysOf(episode({ end: null, start: null }))).toEqual([
    "2026-10-15",
    "2026-10-15",
  ]);
});

test("an episode he says is wrong rereads its units, and every later reading of its day sees it with his words and keeps it (29 Oct 2026: a trip came back with the same mistake)", () => {
  const trip = episode({ id: "ep_00000000000a", units: [U1, U2] });
  const other = episode({ id: "ep_00000000000b", units: [U3] });
  const wrong: Correction = {
    at: "2026-10-29T09:00:00.000Z",
    kind: "wrong",
    note: "Nadia is not coming; Rose and Lou are",
    observations: [trip.id],
    schemaVersion: 1,
  };
  const rereads = rereadAt([wrong], [trip, other]);
  expect(isRereadSince(rereads, U1, "2026-10-29T08:00:00.000Z")).toBe(true);
  expect(isRereadSince(rereads, U2, "2026-10-29T10:00:00.000Z")).toBe(false);
  expect(rereads.has(U3)).toBe(false);
  // Not important hides it, and reads nothing again.
  expect(rereadAt([{ ...wrong, kind: "not-important" }], [trip]).size).toBe(0);
  const seen = earlierFor(trip.day, [trip, other], [wrong]);
  expect(seen.find((m) => m.id === trip.id)?.hidden).toEqual({
    kind: "wrong",
    note: "Nadia is not coming; Rose and Lou are",
  });
  expect(seen.find((m) => m.id === other.id)?.hidden).toBeUndefined();
  // The reading gives a new episode; the hidden one stays in the day's file, so the next reading sees his words again.
  const fixed = episode({
    id: "ep_00000000000c",
    title: "Trip with Rose and Lou",
  });
  const ctx = {
    corrections: [wrong],
    earlier: new Set<string>(),
    lines: [trip, other],
    units: new Set([U1, U2, U3]),
  };
  const written = dayFileOf(trip.day, { episodes: [fixed], gone: [] }, ctx);
  expect(written.map((m) => m.id)).toEqual([trip.id, other.id, fixed.id]);
  expect(
    earlierFor(trip.day, written, [wrong]).find((m) => m.id === trip.id)?.hidden
      ?.note
  ).toBe("Nadia is not coming; Rose and Lou are");
  // Given again under its id, it is the reading's line, once.
  expect(
    dayFileOf(
      trip.day,
      { episodes: [trip], gone: [] },
      { ...ctx, lines: [trip] }
    )
  ).toEqual([trip]);
});

test("a day read again keeps its episodes, but those gone; a changed one keeps its units; units gone leave them; a dangling `within` is null; an older prompt's lines go", () => {
  const dinner = episode({ id: "ep_00000000000a", units: [U1, U2] });
  const call = episode({ id: "ep_00000000000b", units: [U3] });
  const walk = episode({ id: "ep_00000000000c", units: [U2] });
  const old = episode({ id: "ep_00000000000d", madeBy });
  const ctx = {
    corrections: [],
    earlier: new Set<string>(),
    lines: [dinner, call, walk, old],
    // U2 regrouped away.
    units: new Set([U1, U3]),
  };
  const changed = { ...dinner, title: "Dinner with Zoé", units: [U3] };
  const inside = episode({
    id: "ep_00000000000e",
    units: [U1],
    within: "ep_000000000077",
  });
  const written = dayFileOf(
    dinner.day,
    { episodes: [changed, inside], gone: [call.id] },
    ctx
  );
  expect(written).toEqual([
    { ...changed, units: [U1, U3] },
    { ...inside, within: null },
  ]);
});

test("a day is read again when one of its units has no verdict by this prompt on its current content", () => {
  const b = built(U1);
  expect(unread([b], ledger([]))).toBe(true);
  expect(
    unread(
      [b],
      ledger([
        verdict(b.unit, { madeBy: { ...madeBy, prompt: EPISODES_PROMPT } }),
      ])
    )
  ).toBe(false);
  expect(unread([b], ledger([verdict(b.unit)]))).toBe(true);
  // Read again, the day keeps the verdict of a unit already judged on this content, and takes the others.
  const c = built(U2);
  const v2 = { ...madeBy, prompt: EPISODES_PROMPT };
  const known = ledger([verdict(b.unit, { madeBy: v2 })]);
  const said = [
    verdict(b.unit, { importance: 0, madeBy: v2 }),
    verdict(c.unit, { madeBy: v2 }),
  ];
  expect(fresh(said, [b, c], known).map((v) => v.unit)).toEqual([U2]);
});

test("a unit he said was read wrong after its verdict reads its day again, and takes the new verdict", () => {
  const b = built(U1);
  const v2 = {
    ...madeBy,
    prompt: EPISODES_PROMPT,
    run: "2026-10-16T10-00-00.000Z",
  };
  const known = ledger([verdict(b.unit, { madeBy: v2 })]);
  const later = new Map([[U1, "2026-10-28T10:00:00.000Z"]]);
  const earlier = new Map([[U1, "2026-10-15T10:00:00.000Z"]]);
  expect(unread([b], known, earlier)).toBe(false);
  expect(unread([b], known, later)).toBe(true);
  expect(
    fresh([verdict(b.unit, { madeBy: v2 })], [b], known, later)
  ).toHaveLength(1);
});

const HASH = "0000000000000000";
const AREA = "shop";
const unitOf = (id: string, drop?: string) =>
  unit({ drop, hash: HASH, id, source: "line" });
const judged = (
  u: Unit,
  type: Verdict["type"],
  importance: number,
  area: string | null = null
) => verdict(u, { area, importance, madeBy, type });

test("agreement: kept means importance 2+, code-rule drops count as skipped, labels of vanished units are only counted", () => {
  const [ua, ub, uc, ud, ue] = [
    "unit_00000000000a",
    "unit_00000000000b",
    "unit_00000000000c",
    "unit_00000000000d",
    "unit_00000000000e",
  ].map((id) => unitOf(id, id.endsWith("d") ? "newsletter" : undefined)) as [
    Unit,
    Unit,
    Unit,
    Unit,
    Unit,
  ];
  const units = new Map([ua, ub, uc, ud, ue].map((u) => [u.id, u]));
  const verdicts = ledger([
    judged(ua, "to_do", 3, AREA), // kept, matters
    judged(ub, "to_do", 2), // kept, doesn't
    judged(uc, "nothing", 0), // skipped, matters
    // ud: dropped by a rule: skipped, doesn't
    judged(ue, "news", 2), // kept, matters
  ]);
  const labels: MemoryLabel[] = [
    { matters: true, unitId: "unit_00000000000a" },
    { matters: false, unitId: "unit_00000000000b" },
    { matters: true, unitId: "unit_00000000000c" },
    { matters: false, unitId: "unit_00000000000d" },
    { matters: true, unitId: "unit_00000000000e" },
    { matters: true, unitId: "unit_0000000000ff" },
  ];
  expect(agreement(labels, units, verdicts)).toEqual({
    agreement: 3 / 5,
    labeled: 5,
    missing: 1,
    precision: 2 / 3,
    recall: 2 / 3,
  });
});

test("a chat's area hint is the area of the projects that list it, by network chat id and by WhatsApp id", () => {
  const truth = {
    chats: [
      { id: "!a:matrix.local", whatsapp: "1@g.us" },
      { id: "!b:matrix.local" },
    ],
    projects: [
      { area: "construction", chats: ["!a:matrix.local"] },
      { area: "family-money", chats: ["!a:matrix.local"] },
      { area: "shop", chats: [] },
    ],
  } as unknown as Truth;
  const hints = chatAreas(truth);
  expect(hints.get("!a:matrix.local")).toEqual([
    "construction",
    "family-money",
  ]);
  expect(hints.get("1@g.us")).toEqual(["construction", "family-money"]);
  expect(hints.has("!b:matrix.local")).toBe(false);
});
