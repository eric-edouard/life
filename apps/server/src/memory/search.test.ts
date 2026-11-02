import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Moment } from "../records/moment";
import type { Observation } from "../records/observation";
import type { Unit } from "../records/unit";
import { layoutOf, perSection, renderPage } from "./page-format";
import {
  areaFor,
  birthdaysNear,
  birthdayText,
  buildIndex,
  candidateLines,
  coverageLines,
  dayLines,
  dueOf,
  momentLine,
  nextBirthday,
  readIndex,
  matches as searchMatches,
  withSpans,
} from "./search";
import { newestDays } from "./units";
import { meant, namedLike, nearNames } from "./who";
import { holdsAll } from "./words";

test("day: its units, a recorded conversation among them, then its key observations", () => {
  const lines = dayLines({
    facts: ['- obs_1 2026-10-14 todo: Call the glazier "call him"'],
    units: [
      {
        date: "2026-10-14",
        id: "unit_000000000001",
        source: "whatsapp",
        title: "Team",
        topics: "glass",
      },
      {
        date: "2026-10-14",
        id: "unit_000000000002",
        source: "lifelog",
        title: "Recorded conversation",
        topics: "plumbing",
      },
    ],
  });
  expect(lines).toContain("Units (2; `fetch <unit id>`):");
  expect(lines).toContain(
    "- unit_000000000002 2026-10-14 lifelog: Recorded conversation [plumbing]"
  );
  expect(lines).toContain(
    "- unit_000000000001 2026-10-14 whatsapp: Team [glass]"
  );
  expect(lines.slice(-2)).toEqual([
    "Key observations:",
    '- obs_1 2026-10-14 todo: Call the glazier "call him"',
  ]);
});

test("person: a name two people go by lists both, with relation and count", () => {
  const people = [
    {
      aliases: ["Claire"],
      id: "claire",
      name: "Claire Dupont",
      relation: "half-sister",
    },
    {
      aliases: ["Claire"],
      id: "claire-friend",
      name: "Claire (friend)",
      relation: "ex (casual), friend",
    },
    {
      aliases: ["Zoé"],
      id: "zoe",
      name: "Zoé Dupont",
      relation: "half-sister",
    },
  ];
  const matches = namedLike("claire", people);
  expect(matches.map((p) => p.id)).toEqual(["claire", "claire-friend"]);
  expect(namedLike("claire-friend", people)).toHaveLength(1);
  expect(namedLike("Zoe", people)).toHaveLength(1);
  const lines = candidateLines("claire", matches, (id) =>
    id === "claire" ? 4 : 9
  );
  expect(lines).toContain(
    "- claire: Claire Dupont, half-sister, 4 observations"
  );
  expect(lines).toContain(
    "- claire-friend: Claire (friend), ex (casual), friend, 9 observations"
  );
  expect(candidateLines("zoe", namedLike("zoe", people), () => 0)).toEqual([]);
});

test("search: an observation hit names the unit it comes from and who is in it", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "life-search-")), "i.sqlite");
  const o = {
    at: "2026-10-14T10:01:00.000Z",
    date: "2026-10-14",
    entities: ["project:photo-app"],
    id: "obs_1",
    importance: 2,
    quote: "il est à rework",
    source: { channel: "lifelog", ref: "j:0@x" },
    text: "Jean will rework the photo-app beautify prompt.",
    type: "to_do",
    unit: "unit_000000000001",
  } as unknown as Observation;
  const unit = {
    date: "2026-10-14",
    id: "unit_000000000001",
    people: ["person:jerome", "unknown:Bob"],
    source: "lifelog",
    title: "Improving output prompts before advertising tests",
  } as unknown as Unit;
  const standing = {
    corrections: [],
    latest: new Map(),
    live: new Set([unit.id]),
    retired: new Map(),
  };
  buildIndex([o], path, standing, [{ unit }]);
  const db = new Database(path, { readonly: true });
  const [hit] = searchMatches(db, "beautify");
  expect(hit).toEndWith(
    '(lifelog "Improving output prompts before advertising tests"; jerome, Bob)'
  );
  // A handle held across a rebuild reads the new index (one held across a file swap failed).
  buildIndex([{ ...o, text: "Jean will polish the prompt." }], path, standing);
  expect(searchMatches(db, "beautify")).toEqual(["(nothing found)"]);
  expect(searchMatches(db, "polish")[0]).toContain("polish the prompt");
  // A table no schema has any more goes at the next rebuild.
  const writer = new Database(path);
  writer.run("create table stale (x)");
  writer.close();
  buildIndex([o], path, standing, [{ unit }]);
  expect(
    db.query("select name from sqlite_schema where name = 'stale'").get()
  ).toBeNull();
  // A rebuild that fails leaves the last index whole.
  expect(() =>
    buildIndex(
      [{ ...o, source: undefined } as unknown as Observation],
      path,
      standing
    )
  ).toThrow();
  expect(searchMatches(db, "beautify")[0]).toBe(hit);
  // A unit's people are kept once each: the index takes them as reindex maps them today (two refs may fold into one).
  buildIndex([o], path, standing, [
    { unit: { ...unit, people: ["person:jerome", "person:jerome"] } },
  ]);
  expect(
    db.query("select person from unit_people where unit = ?").all(unit.id)
  ).toEqual([{ person: "person:jerome" }]);
  buildIndex([o], path, standing, [{ unit }]);
  // `from`/`to` bound observations and units too, both days included.
  expect(searchMatches(db, "beautify", { from: "2026-10-14" })[0]).toBe(hit);
  expect(searchMatches(db, "beautify", { to: "2026-10-14" })[0]).toBe(hit);
  expect(searchMatches(db, "beautify", { from: "2026-10-15" })).toEqual([
    "(nothing found)",
  ]);
  expect(searchMatches(db, "beautify", { to: "2026-10-13" })).toEqual([
    "(nothing found)",
  ]);
  // What Life holds about someone: by source and by month, and what it can't hold.
  const cover = coverageLines(db, "person:jerome", []);
  expect(cover[0]).toContain("its memory starts on 2026-10-14");
  expect(cover).toContain("- lifelog: 1 units, 2026-10-14 to 2026-10-14");
  expect(cover).toContain(
    "- 2026-10: 1 units (lifelog 1), 0 observations, 0 moments"
  );
  expect(cover.at(-1)).toContain("calls");
  db.close();
});

test("person: a misheard or misspelled name lists the names near it, never a guess", () => {
  const people = [
    { aliases: ["Joel", "Joël"], id: "joel", name: "Joël Marchand" },
    { aliases: [], id: "noel", name: "Noel" },
    { aliases: ["Ines"], id: "ines", name: "Inès Fabre" },
  ];
  expect(nearNames("Joelle", people).map((p) => p.id)).toEqual(["joel"]);
  expect(nearNames("Jowl", people).map((p) => p.id)).toEqual(["joel"]);
  expect(nearNames("Joël Marchant", people).map((p) => p.id)).toEqual(["joel"]);
  expect(nearNames("Joe", people).map((p) => p.id)).toEqual(["joel"]);
  // A name of four letters or fewer allows one edit only: "Nil" is two from "Noel".
  expect(nearNames("Nil", people)).toEqual([]);
  expect(nearNames("Zebulon", people)).toEqual([]);
});

test("person pages back by whole days: a day is never cut, and `next` is the day to page back from", () => {
  const items = [
    "2026-10-20",
    "2026-10-19",
    "2026-10-19",
    "2026-10-18",
    "2026-10-17",
  ];
  const day = (d: string) => d;
  expect(newestDays(items, day, 2)).toEqual({
    next: "2026-10-19",
    taken: ["2026-10-20", "2026-10-19", "2026-10-19"],
  });
  expect(newestDays(items, day, 2, "2026-10-19")).toEqual({
    next: undefined,
    taken: ["2026-10-18", "2026-10-17"],
  });
  expect(newestDays(items, day, 9)).toEqual({ next: undefined, taken: items });
  expect(newestDays(items, day, 2, "2026-10-17")).toEqual({
    next: undefined,
    taken: [],
  });
});

test("readIndex takes no async read: the index closes when the read returns", () => {
  // @ts-expect-error a promise would settle after the index is closed (`bun run check` types this file)
  const refused = () => readIndex(async () => 1);
  expect(refused).toBeFunction();
});

test("a day opens with what happened: its moments, when, what, where, how they stand and with whom", () => {
  const m = {
    day: "2026-10-15",
    end: null,
    id: "mom_000000000001",
    people: [
      { ref: "person:bastien", role: "with" },
      { ref: "unknown:Cédric", role: "with" },
    ],
    place: "Claire's house",
    start: "2026-10-16 16:20",
    status: "happened",
    title: "Road trip to see the sisters with Bastien",
    units: ["unit_000000000001"],
  } as Moment;
  expect(momentLine(m)).toBe(
    "- mom_000000000001 2026-10-16 16:20 Road trip to see the sisters with Bastien @ Claire's house (happened; bastien with, Cédric with) [unit_000000000001]"
  );
  expect(dayLines({ moments: [m] }).slice(0, 2)).toEqual([
    "Moments (what happened or is planned):",
    momentLine(m),
  ]);
  expect(dayLines({})[0]).toStartWith("Units (0;");
});

test("holding all the words: case and accents ignored, every word needed, a query with no word holds nothing", () => {
  const holds = holdsAll("Château pondres");
  expect(holds("Dinner at the chateau de Pondres")).toBe(true);
  expect(holds("Dinner at the château")).toBe(false);
  expect(holdsAll("??")("anything")).toBe(false);
});

test("a name means who it resolves to, listed first among those going by it; a name nothing resolves means no one", () => {
  const people = [
    { aliases: ["Claire"], id: "claire", name: "Claire Dupont" },
    { aliases: ["Claire"], id: "claire-friend", name: "Claire (friend)" },
    { aliases: [], id: "ann", name: "Ann Kerr" },
  ];
  const mean = (name: string, resolve: (s: string) => string | null) =>
    meant(name, {
      canon: (r: string) => r,
      inferred: [],
      resolve,
      truth: { people } as never,
    });
  const ids = (m: ReturnType<typeof mean>) => [
    m.known,
    m.same.map((p) => p.id),
  ];
  // He said this Claire is his friend (`this-is`): she is the one, listed first.
  expect(
    ids(mean("Claire", (s) => (s === "Claire" ? "person:claire-friend" : null)))
  ).toEqual(["claire-friend", ["claire-friend", "claire"]]);
  expect(ids(mean("Claire", () => null))).toEqual([
    "claire",
    ["claire", "claire-friend"],
  ]);
  // A name he said is Ann: she is meant and listed first, though she goes by another name.
  expect(ids(mean("Claire", () => "person:ann"))).toEqual([
    "ann",
    ["ann", "claire", "claire-friend"],
  ]);
  expect(ids(mean("Clai", () => null))).toEqual([undefined, []]);
});

const SAID_BY = / (by|heard as) jean/;

// audit-1-apple-open-loop: a plan he said aloud to no one (call the shop before buying the train) had no owner, so no
// one nudged him. `read_day` now lists it as due on its day; never someone else's to-do, a sender's or one already retired.
// Up to a week late it is still listed, labelled (a missed daily review), and what he waits on, on its day (#99).
test("audit-1-apple-open-loop: day lists the open to-dos and promises of the day or up to a week late, and waiting items on their day", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "life-due-")), "i.sqlite");
  const loop = (id: string, over: Partial<Observation>) =>
    ({
      about: "person:me",
      at: "2026-10-18T17:12:59.670Z",
      confidence: 0.9,
      date: "2026-10-18",
      entities: ["person:me"],
      id,
      importance: 3,
      quote: "tomorrow I'm going to call them",
      source: { channel: "lifelog", ref: "j:8@x" },
      speaker: "person:me",
      text: "Call the shop to ask for a morning pickup before booking the train.",
      type: "to_do",
      unit: "unit_000000000001",
      when: "2026-10-19",
      ...over,
    }) as unknown as Observation;
  const standing = {
    corrections: [],
    latest: new Map(),
    live: new Set(["unit_000000000001"]),
    retired: new Map([
      [
        "obs_000000000006",
        { by: "obs_000000000001", observation: "obs_000000000006" },
      ],
    ]),
  };
  buildIndex(
    [
      loop("obs_000000000001", {}),
      // His promise whose words a sender wrote: labelled "by", never left out (decision 11b).
      loop("obs_000000000002", {
        source: { channel: "whatsapp", ref: "m1" },
        speaker: "person:jean",
        type: "promise",
      }),
      loop("obs_000000000003", { speaker: "person:jean" }),
      loop("obs_000000000004", { speaker: "unknown:shop@mail.test" }),
      // His own to-do filed under a project is still his.
      loop("obs_000000000005", { about: "project:house" }),
      loop("obs_000000000006", {}),
      loop("obs_000000000007", { when: "2026-10-20" }),
      loop("obs_000000000008", { importance: 2 }),
      loop("obs_000000000009", { type: "news" }),
      // His promise whose quote opens with the other's request is still his to keep.
      loop("obs_000000000010", { speaker: "person:jean", type: "promise" }),
      // Late: 3 and 7 days overdue are listed (labelled), 8 days is not.
      loop("obs_000000000011", { when: "2026-10-16" }),
      loop("obs_000000000015", { when: "2026-10-12" }),
      loop("obs_000000000012", { when: "2026-10-11" }),
      // What he waits on from someone: on its day only.
      loop("obs_000000000013", {
        speaker: "person:jean",
        type: "waiting_on_someone",
      }),
      loop("obs_000000000014", {
        type: "waiting_on_someone",
        when: "2026-10-18",
      }),
      // Undated: the day after it was said (18 Oct), not two days after.
      loop("obs_000000000016", { when: undefined }),
      loop("obs_000000000017", { date: "2026-10-17", when: undefined }),
    ],
    path,
    standing as never
  );
  const lines = dueOf(new Database(path, { readonly: true }), "2026-10-19", {
    goals: [],
    levels: new Map(),
    more: [],
    shown: new Map(),
    today: "2026-10-19",
  });
  // Ranked: his promises first, then his to-dos, then what he waits on.
  expect(lines.map((l) => l.split(" ")[1])).toEqual([
    "obs_000000000002",
    "obs_000000000010",
    "obs_000000000001",
    "obs_000000000005",
    "obs_000000000011",
    "obs_000000000015",
    "obs_000000000016",
    "obs_000000000013",
  ]);
  expect(lines.filter((l) => l.endsWith(" (overdue)"))).toEqual(
    lines.slice(4, 6)
  );
  // Who spoke, when not him: "by" a sender, "heard as" a voice (lifelog misnames some).
  expect(lines.map((l) => l.match(SAID_BY)?.[0] ?? "")).toEqual([
    " by jean",
    " heard as jean",
    "",
    "",
    "",
    "",
    "",
    " heard as jean",
  ]);
  expect(dayLines({ due: lines })[0]).toStartWith("Due (open items");
});

test("a Between us line shows the days of its first and latest evidence", () => {
  const text = renderPage({
    hold: "> Ana.",
    layout: layoutOf("person:ana", true),
    meta: {
      built: "2026-10-18T02:00:00.000Z",
      madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
      name: "Ana",
      page: "person:ana",
      schemaVersion: 1,
      seen: "r",
    },
    owner: [],
    sections: {
      ...perSection(),
      bond: [
        {
          cites: ["obs_aaaaaaaaaaaa", "obs_bbbbbbbbbbbb"],
          text: "Ana and Jean agreed to keep money apart.",
        },
      ],
    },
    title: "Ana",
  });
  const day: Record<string, string> = {
    obs_aaaaaaaaaaaa: "2026-03-01",
    obs_bbbbbbbbbbbb: "2026-09-12",
  };
  expect(withSpans(text, (id) => (day[id] ? [day[id]] : []))).toContain(
    "agreed to keep money apart. [obs_aaaaaaaaaaaa, obs_bbbbbbbbbbbb] (since 2026-03-01 · last evidence 2026-09-12)"
  );
});

test("birthdays: the next date, days left and age; day lists this day and the next 7, soonest first", () => {
  expect(nextBirthday("1993-11-12", "2026-11-09")).toEqual({
    age: 33,
    day: "2026-11-12",
    left: 3,
  });
  // Passed this year: next year's; no year, no age.
  expect(nextBirthday("--01-07", "2026-10-21")).toEqual({
    age: null,
    day: "2027-01-07",
    left: 78,
  });
  expect(birthdayText(nextBirthday("--10-21", "2026-10-21"))).toBe(
    "21 Oct (today)"
  );
  expect(
    birthdaysNear(
      [
        { birthday: "2000-10-28", id: "ana", name: "Ana" },
        { birthday: "--10-21", id: "jean", name: "Jean" },
        { birthday: "--10-29", id: "late", name: "Late" },
        { id: "none", name: "None" },
      ],
      "2026-10-21"
    )
  ).toEqual([
    "- Jean (`person jean`): 21 Oct (today)",
    "- Ana (`person ana`): 28 Oct (in 7 days, turns 26)",
  ]);
  // 29 Feb falls on 1 Mar in other years.
  expect(nextBirthday("--02-29", "2027-02-28")).toMatchObject({
    day: "2027-03-01",
    left: 1,
  });
  // Across the new year.
  expect(
    birthdaysNear(
      [{ birthday: "--01-02", id: "jan", name: "Jan" }],
      "2026-12-28"
    )
  ).toEqual(["- Jan (`person jan`): 2 Jan (in 5 days)"]);
  // First in `read_day`, before what is due.
  expect(dayLines({ born: ["- born"], due: ["- due"] }).slice(0, 3)).toEqual([
    "Birthdays (this day and the next 7):",
    "- born",
    "",
  ]);
});

test("area: an area's or a project's id or name, never a part of one", () => {
  const truth = {
    areas: [{ id: "construction", name: "Construction" }],
    projects: [{ area: "construction", id: "house", name: "The House" }],
  } as unknown as Parameters<typeof areaFor>[1];
  expect(areaFor("construction", truth)).toEqual({
    id: "construction",
    project: undefined,
  });
  expect(areaFor("CONSTRUCTION", truth).id).toBe("construction");
  expect(areaFor("house", truth).project?.id).toBe("house");
  expect(areaFor("the house", truth).id).toBe("construction");
  expect(areaFor("constr", truth).id).toBeUndefined();
});
