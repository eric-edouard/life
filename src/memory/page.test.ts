import { expect, test } from "bun:test";
import type { Observation } from "../schema";
import {
  assemble,
  bodyOf,
  type Check,
  changes,
  checkReply,
  fit,
  generated,
  homeOf,
  type Known,
  layoutOf,
  lineHash,
  liveLines,
  oftenLine,
  ownerEdits,
  type PageLine,
  pagedPeople,
  parsePage,
  perSection,
  placed,
  readLine,
  renderLine,
  renderPage,
  type Sections,
  settle,
} from "./page";

const A = "obs_aaaaaaaaaaaa";
const B = "obs_bbbbbbbbbbbb";
const C = "obs_cccccccccccc";
const D = "obs_dddddddddddd";
const TODAY = "2026-10-20";
const PLAIN = layoutOf("person:hans");
const OWNED = layoutOf("person:me");

const obs = (id: string, date: string, over: Partial<Observation> = {}) =>
  ({
    date,
    id,
    source: { channel: "whatsapp", ref: "r" },
    speaker: "person:dad",
    validFrom: null,
    ...over,
  }) as Observation;

const known = (list: Observation[], retired: string[] = []): Known => ({
  byId: new Map(list.map((o) => [o.id, o])),
  retired: new Set(retired),
});

const KNOWN = known([
  obs(A, "2026-10-01"),
  obs(B, "2026-10-12"),
  obs(C, "2026-10-18"),
  obs(D, "2026-10-19"),
]);

/** A page's sections, the ones not given empty. */
const of = (given: Partial<Sections>): Sections => ({
  ...perSection<PageLine>(),
  ...given,
});

const sections = (): Sections =>
  of({
    history: [{ cites: [A], date: "2026-10-01", text: "Plan sent." }],
    now: [
      { cites: [B], text: "The handover is expected around 17 Oct." },
      { cites: [C], text: "Steel supports need Jean's OK." },
    ],
  });

const page = (s = sections(), owner: { section: "now"; text: string }[] = []) =>
  renderPage({
    hold: "> **Hans** · builder",
    meta: {
      built: "2026-10-11T02:00:00.000Z",
      madeBy: {
        engine: "codex",
        model: "m",
        prompt: "memory-pages.v2",
        run: "r1",
      },
      name: "Hans",
      page: "person:hans",
      schemaVersion: 1,
      seen: "2026-10-11T00-00-00.000Z",
    },
    often: ["- construction (12), money (4)"],
    owner,
    sections: s,
    title: "Hans",
  });

const check = (over: Partial<Check> = {}): Check => {
  const s = sections();
  return {
    changed: new Set(),
    covered: new Set(s.now.concat(s.history).flatMap((l) => l.cites)),
    current: liveLines(s),
    fresh: new Set([D]),
    known: KNOWN,
    layout: PLAIN,
    owner: [],
    ...over,
  };
};

test("a page reads back as written: frontmatter, Now and History lines with cites, Often talk about left alone", () => {
  const text = page();
  expect(text).toContain(
    "## Often talk about\n\n- construction (12), money (4)"
  );
  const parsed = parsePage(text);
  expect(parsed?.meta.page).toBe("person:hans");
  expect(parsed && generated(parsed)).toEqual(sections());
  const l = sections().history[0] as PageLine;
  expect(readLine("history", renderLine("history", l))).toEqual(l);
  expect(parsed && ownerEdits(parsed)).toEqual({ lines: [], removed: [] });
});

test("the owner's edits: a rewritten line is his, a deleted one is remembered by its cites", () => {
  const text = page()
    .replace(
      "- The handover is expected around 17 Oct. [obs_bbbbbbbbbbbb]",
      "- The handover moved to 25 Oct (Hans told me on the phone)."
    )
    .replace("- 2026-10-01 · Plan sent. [obs_aaaaaaaaaaaa]\n", "");
  const parsed = parsePage(text);
  expect(parsed && ownerEdits(parsed)).toEqual({
    lines: [
      {
        section: "now",
        text: "- The handover moved to 25 Oct (Hans told me on the phone).",
      },
    ],
    removed: [[B], [A]],
  });
  // Rendered again, his line stays verbatim and is still his.
  const again = parsePage(
    page(sections(), [
      { section: "now", text: "- The handover moved to 25 Oct." },
    ])
  );
  expect(again && ownerEdits(again).lines.map((l) => l.text)).toEqual([
    "- The handover moved to 25 Oct.",
  ]);
});

test("one fact, one page: a person who has a page owns what is only about them, else the project's area, else Jean's page for what is his alone, else the observation's area", () => {
  const truth = { projects: [{ area: "construction", id: "house" }] } as never;
  const paged = new Set(["person:hans", "person:dad", "person:me"]);
  const home = (
    entities: string[],
    area: string | null = null,
    type: Observation["type"] = "news",
    unmapped = false
  ) => homeOf({ area, entities, type, unmapped }, truth, paged);
  expect(home(["person:me", "person:hans"], "shop")).toBe("person:hans");
  expect(home(["person:hans", "project:house"])).toBe("person:hans");
  // Two people, or a person without a page: the project's area, then its own.
  expect(home(["person:hans", "person:dad", "project:house"], "shop")).toBe(
    "area:construction"
  );
  expect(home(["person:stranger"], "shop")).toBe("area:shop");
  expect(home(["person:stranger"])).toBeNull();
  // About Jean alone: what he is like is his, wherever it was filed; other news stays in its area.
  expect(home(["person:me"], "relationships", "preference")).toBe("person:me");
  // Filed with no one at all, it is not known to be about him.
  expect(home([], "relationships", "person")).toBe("area:relationships");
  expect(home(["person:me"], "money-admin")).toBe("area:money-admin");
  // Nothing else claims it: his own life.
  expect(home(["person:me"])).toBe("person:me");
  // Who extraction said it is about wins: Jean's goal that names Dad is Jean's, a fact about Dad told Hans is Dad's.
  const about = (a: string, entities: string[]) =>
    homeOf(
      { about: a, area: "shop", entities, type: "news", unmapped: false },
      truth,
      paged
    );
  expect(about("person:me", ["person:dad", "person:me"])).toBe("person:me");
  expect(about("person:dad", ["person:dad", "person:hans"])).toBe("person:dad");
  expect(about("person:stranger", ["person:stranger"])).toBe("area:shop");
  // A project still wins, and a name Life could not map is never him.
  expect(home(["project:house"], null, "preference")).toBe("area:construction");
  expect(home(["person:me"], "friends", "person", true)).toBe("area:friends");
  expect(home(["person:me"], null, "news", true)).toBeNull();
});

test("people with pages: everyone in truth, and an inferred person from five observations about them alone", () => {
  const about = (entities: string[], salience = 2) => ({ entities, salience });
  const five = Array.from({ length: 5 }, () => about(["person:inf-glazier"]));
  const paged = pagedPeople(
    [
      ...five,
      about(["person:inf-plumber"]),
      about(["person:inf-plumber", "person:hans"]),
      about(["person:inf-plumber"], 1),
    ],
    { people: [{ id: "me" }, { id: "hans" }] } as never
  );
  expect([...paged].sort()).toEqual([
    "person:hans",
    "person:inf-glazier",
    "person:me",
  ]);
});

test("placed: the pages and the email file a page line by its home; a conditional claim or one with no home is no page line", () => {
  const line = (id: string, entities: string[], over = {}) =>
    ({
      area: null,
      entities,
      id,
      salience: 3,
      type: "news",
      unmapped: false,
      ...over,
    }) as Observation & { unmapped: boolean };
  const { homes } = placed(
    [
      line("hans", ["person:hans"]),
      line("joke", ["person:hans"], { modality: "conditional" }),
      line("minor", ["person:hans"], { salience: 1 }),
      line("nowhere", ["person:stranger"]),
    ],
    { people: [{ id: "hans" }], projects: [] } as never
  );
  expect(
    [...homes].map(([home, list]) => [home, list.map((h) => h.o.id)])
  ).toEqual([["person:hans", ["hans"]]]);
});

test("kept lines stay word for word; one that lost an observation keeps the live ones and is flagged; one replaced moves to History", () => {
  const s = of({
    history: [
      { cites: [A, "obs_000000000000"], date: "2026-10-01", text: "Old." },
    ],
    now: [
      { cites: [B], text: "Fine." },
      { cites: [B, "obs_111111111111"], text: "Lost one." },
      { cites: [C], text: "Replaced." },
      { cites: ["obs_222222222222"], text: "Hidden." },
      { cites: [B, C], text: "Half replaced." },
    ],
  });
  const r = settle(s, known([...KNOWN.byId.values()], [C]));
  expect(r.sections.now.map((l) => l.text)).toEqual([
    "Fine.",
    "Lost one.",
    "Half replaced.",
  ]);
  // Both rest on live observations only now, and the model is asked about them once.
  expect(r.sections.now.map((l) => l.cites)).toEqual([[B], [B], [B]]);
  expect(r.changed.size).toBe(2);
  expect(r.sections.history.map((l) => [l.date, l.text]).sort()).toEqual([
    ["2026-10-01", "Old."],
    ["2026-10-18", "Replaced."],
  ]);
});

test("the reply may add for new observations, finish a line, rewrite a changed line; nothing else gets in", () => {
  const s = sections();
  const first = lineHash(renderLine("now", s.now[0] as PageLine));
  const second = lineHash(renderLine("now", s.now[1] as PageLine));
  const r = checkReply(
    {
      done: [first, "nope"],
      now: [
        { cites: [D], text: "New." },
        { cites: [D], text: "Repeat of New." },
        { cites: [B], text: "Not new." },
        { cites: [D, "obs_999999999999"], text: "Unknown." },
        { cites: [], text: "No cite." },
        { cites: [D], text: "Mine." },
      ],
      past: [{ cites: [D], date: "2026-10-19", text: "Past, but D is used." }],
      rewrite: [
        { cites: [C], line: second, text: "Changed." },
        { cites: [C], line: first, text: "Not changed." },
      ],
    },
    check({ changed: new Set([second]), owner: ["Mine."] })
  );
  expect(r.add.map((l) => l.text)).toEqual(["New."]);
  expect(r.done).toEqual([first]);
  expect([...r.rewrite.keys()]).toEqual([second]);
  expect(r.rejects.map((x) => x.reason).sort()).toEqual([
    "no-cite",
    "not-new",
    "owner-line",
    "repeat",
    "repeat",
    "unchanged-line",
    "unknown-cite",
  ]);
});

test("no churn: with nothing new, the page comes out as it went in", () => {
  const settled = settle(sections(), KNOWN);
  const next = assemble(
    settled.sections,
    checkReply({}, check({ fresh: new Set() })),
    KNOWN,
    { fixed: 10, layout: PLAIN, today: TODAY }
  );
  expect(changes(sections(), next)).toEqual({ added: 0, moved: 0, removed: 0 });
});

test("aging: a Now line with nothing newer than 21 days moves to History, dated by its newest observation", () => {
  const next = assemble(
    settle(sections(), KNOWN).sections,
    checkReply({}, check({ fresh: new Set() })),
    KNOWN,
    { fixed: 10, layout: PLAIN, today: "2026-11-05" }
  );
  // B (12 Oct) is 24 days old, C (18 Oct) 18 days.
  expect(next.now.map((l) => l.text)).toEqual([
    "Steel supports need Jean's OK.",
  ]);
  expect(next.history.map((l) => `${l.date} ${l.text}`)).toEqual([
    "2026-10-12 The handover is expected around 17 Oct.",
    "2026-10-01 Plan sent.",
  ]);
});

test("a finished line moves to History", () => {
  const s = sections();
  const first = lineHash(renderLine("now", s.now[0] as PageLine));
  const next = assemble(
    s,
    checkReply(
      {
        done: [first],
        now: [{ cites: [D], text: "Newer plan." }],
      },
      check()
    ),
    KNOWN,
    { fixed: 10, layout: PLAIN, today: TODAY }
  );
  expect(next.now.map((l) => l.text)).toEqual([
    "Newer plan.",
    "Steel supports need Jean's OK.",
  ]);
  expect(next.history.map((l) => l.text)).toEqual([
    "The handover is expected around 17 Oct.",
    "Plan sent.",
  ]);
});

test("the word budget: History goes first, oldest line first, then Now's oldest", () => {
  const words = (n: number) =>
    Array.from({ length: n }, () => "word").join(" ");
  const many = of({
    history: Array.from({ length: 40 }, (_, i) => ({
      cites: [A],
      date: `2026-09-${String(10 + (i % 18)).padStart(2, "0")}`,
      text: words(10),
    })),
    now: [
      { cites: [D], text: words(100) },
      { cites: [C], text: words(100) },
      { cites: [B], text: words(100) },
    ],
  });
  const fitted = fit(many, KNOWN, 400, PLAIN);
  const total = (s: Sections) =>
    s.now
      .concat(s.history)
      .reduce((n, l) => n + l.text.split(" ").length + (l.date ? 1 : 0), 0);
  expect(400 + total(fitted)).toBeLessThanOrEqual(800);
  expect(fitted.now.map((l) => l.cites[0])).toEqual([D, C]);
  // Now's oldest line moved to History to leave room, and History lost its oldest first.
  expect(fitted.history.length).toBeGreaterThan(0);
  expect(fitted.history.length).toBeLessThanOrEqual(30);
  const days = fitted.history.map((l) => l.date ?? "");
  expect(days).toEqual([...days].sort().reverse());
});

test("Often talk about is the topics that repeat, most first", () => {
  expect(
    oftenLine(
      new Map([
        ["ai", 3],
        ["money", 12],
        ["once", 1],
      ])
    )
  ).toEqual(["- money (12), ai (3)"]);
  expect(oftenLine(new Map([["once", 1]]))).toEqual([]);
});

test("what changed counts lines added, moved to History and removed; a reader gets the whole page", () => {
  const after = of({
    history: [
      ...sections().history,
      {
        cites: [B],
        date: "2026-10-12",
        text: "Steel supports need Jean's OK.",
      },
    ],
    now: [{ cites: [B], text: "Handed over." }],
  });
  expect(changes(sections(), after)).toEqual({
    added: 1,
    moved: 1,
    removed: 1,
  });
  // A reader gets the whole page, History included, without its frontmatter.
  expect(bodyOf(page())).toContain("Steel supports");
  expect(bodyOf(page())).toContain("## History");
  expect(bodyOf(page())).not.toContain("schemaVersion");
  expect(perSection()).toEqual({ health: [], history: [], now: [], views: [] });
});

// --- Jean's own page ---------------------------------------------------------------------------------------------

const MINE = "obs_eeeeeeeeeeee";
const OWN = known([
  obs(A, "2026-06-01", { speaker: "person:me" }),
  obs(B, "2026-08-01"),
  obs(C, "2026-10-18"),
  obs(MINE, "2026-10-19", { speaker: "person:me" }),
]);

test("his page takes lines in its own sections; a section a page lacks is refused", () => {
  const r = checkReply(
    {
      now: [
        { cites: [MINE], section: "views", text: "Values honesty." },
        { cites: [C], section: "health", text: "Sleeps badly." },
        { cites: [C], section: "history", text: "Undated." },
      ],
    },
    check({
      covered: new Set(),
      current: new Map(),
      fresh: new Set([C, MINE]),
      known: OWN,
      layout: OWNED,
    })
  );
  expect(r.add.map((l) => [l.section, l.text])).toEqual([
    ["views", "Values honesty."],
    ["health", "Sleeps badly."],
  ]);
  expect(r.rejects.map((x) => x.reason)).toEqual(["shape"]);
  // Anyone else's page has Now only.
  const other = checkReply(
    { now: [{ cites: [D], section: "views", text: "Elsewhere." }] },
    check()
  );
  expect(other.rejects.map((x) => x.reason)).toEqual(["section"]);
});

test("a kept line may take in new observations, keeping its own; it may not drop them or reuse old ones", () => {
  const s = sections();
  const first = lineHash(renderLine("now", s.now[0] as PageLine));
  const r = checkReply(
    {
      rewrite: [
        {
          cites: [B, D],
          line: first,
          text: "Handover around 17 Oct, confirmed.",
        },
      ],
    },
    check()
  );
  expect(r.rewrite.get(first)).toEqual({
    cites: [B, D],
    text: "Handover around 17 Oct, confirmed.",
  });
  const refused = checkReply(
    {
      rewrite: [
        { cites: [D], line: first, text: "Drops B." },
        { cites: [B, C], line: first, text: "C is not new." },
      ],
    },
    check()
  );
  expect(refused.rewrite.size).toBe(0);
  expect(refused.rejects.map((x) => x.reason)).toEqual([
    "unchanged-line",
    "unchanged-line",
  ]);
});

test("his views never age, his health ages after 60 days, Now after 21; his page is larger", () => {
  const s = of({
    health: [
      { cites: [B], text: "Old fever." },
      { cites: [C], text: "Sleeps badly." },
    ],
    history: [],
    now: [{ cites: [B], text: "A trip in August." }],
    views: [{ cites: [A], text: "Values honesty." }],
  });
  const next = assemble(
    settle(s, OWN).sections,
    checkReply({}, check({ fresh: new Set(), known: OWN, layout: OWNED })),
    OWN,
    { fixed: 10, layout: OWNED, today: TODAY }
  );
  expect(next.views?.map((l) => l.text)).toEqual(["Values honesty."]);
  expect(next.health?.map((l) => l.text)).toEqual(["Sleeps badly."]);
  expect(next.now).toEqual([]);
  expect(next.history.map((l) => `${l.date} ${l.text}`)).toEqual([
    "2026-08-01 A trip in August.",
    "2026-08-01 Old fever.",
  ]);
  // Over budget, the oldest line of a section that ages goes to History first; his views, which never age, go last.
  const words = (n: number) => Array.from({ length: n }, () => "w").join(" ");
  const tight = fit({ ...s, now: [{ cites: [C], text: words(145) }] }, OWN, 0, {
    ...OWNED,
    words: 300,
  });
  expect(tight.views?.map((l) => l.text)).toEqual(["Values honesty."]);
  expect(tight.health?.map((l) => l.text)).toEqual(["Sleeps badly."]);
  expect(tight.history.map((l) => l.text)).toEqual(["Old fever."]);
});

test("his page renders its sections in order and reads back; other pages keep Now and History only", () => {
  const s = of({
    health: [{ cites: [C], text: "Sleeps badly." }],
    history: [],
    now: [],
    views: [{ cites: [A], text: "Values honesty." }],
  });
  const text = renderPage({
    hold: "> Jean.",
    meta: {
      built: "2026-10-18T02:00:00.000Z",
      madeBy: {
        engine: "codex",
        model: "m",
        prompt: "memory-pages.v3",
        run: "r",
      },
      name: "Jean",
      page: "person:me",
      schemaVersion: 1,
      seen: "r",
    },
    owner: [{ section: "views", text: "- Mine, as I wrote it." }],
    sections: s,
    title: "Jean",
  });
  expect(text.indexOf("## Views, values and habits")).toBeLessThan(
    text.indexOf("## Health")
  );
  const parsed = parsePage(text);
  expect(parsed && generated(parsed)).toEqual(s);
  expect(parsed && ownerEdits(parsed).lines).toEqual([
    { section: "views", text: "- Mine, as I wrote it." },
  ]);
  // A line of his under Health on someone else's page stays his, in Now there.
  const onTimo = page(sections(), [
    { section: "health", text: "- Hans hurt his back." },
  ] as never);
  expect(onTimo).not.toContain("## Health");
  expect(parsePage(onTimo)?.raw.now).toContain("- Hans hurt his back.");
  expect(bodyOf(text)).toContain(
    "## Views, values and habits\n\n- Values honesty. [obs_aaaaaaaaaaaa]\n- Mine, as I wrote it."
  );
  expect(page()).not.toContain("## Views");
  expect(page()).not.toContain("## Health");
});
