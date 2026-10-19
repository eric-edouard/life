import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Moment, Observation, Unit } from "../schema";
import {
  chapter,
  conversation,
  lifelogStore,
  page,
  turn,
} from "../sources/fixtures";
import { apply, readConversations } from "../sources/lifelog";
import { holdsAll } from "./raw";
import {
  buildIndex,
  candidateLines,
  dayLines,
  momentLine,
  namedLike,
  readIndex,
  matches as searchMatches,
} from "./search";

test("day: the conversations with their chapters and people, then the chat and mail units", () => {
  const store = lifelogStore();
  apply(
    store,
    page({
      chapters: [
        chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:05:00.000Z"),
      ],
      conversations: [conversation("c1")],
      turns: [turn(0, "2026-10-14T10:01:00.000Z", "p1", "Anne-Sophie")],
    })
  );
  const lines = dayLines(
    readConversations(store, new Date("2026-10-14T00:00:00Z")),
    [
      {
        date: "2026-10-14",
        id: "u_000000000001",
        source: "whatsapp",
        title: "Team",
        topics: "glass",
      },
    ],
    ['- obs_1 2026-10-14 todo: Call the glazier "call him"']
  );
  expect(lines).toContain("Recorded conversations (1; `fetch <id>`):");
  expect(
    lines.some((l) => l.includes("- c1 ") && l.endsWith("The plumber"))
  ).toBe(true);
  expect(lines.some((l) => l.includes("a (Anne-Sophie): Summary of a"))).toBe(
    true
  );
  expect(lines).toContain("Chat and mail units (1; `fetch <unit id>`):");
  expect(lines).toContain("- u_000000000001 2026-10-14 whatsapp: Team [glass]");
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
    quote: "il est à rework",
    salience: 2,
    source: { channel: "lifelog", ref: "j:0@x" },
    text: "Jean will rework the photo-app beautify prompt.",
    type: "todo",
    unit: "u_000000000001",
  } as unknown as Observation;
  const unit = {
    date: "2026-10-14",
    id: "u_000000000001",
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
  db.close();
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
    units: ["u_000000000001"],
  } as Moment;
  expect(momentLine(m)).toBe(
    "- mom_000000000001 2026-10-16 16:20 Road trip to see the sisters with Bastien @ Claire's house (happened; bastien with, Cédric with) [u_000000000001]"
  );
  expect(dayLines([], [], [], [], [m]).slice(0, 2)).toEqual([
    "What happened (moments):",
    momentLine(m),
  ]);
  expect(dayLines([], [])[0]).toStartWith("Recorded conversations");
});

test("holding all the words: case and accents ignored, every word needed, a query with no word holds nothing", () => {
  const holds = holdsAll("Château pondres");
  expect(holds("Dinner at the chateau de Pondres")).toBe(true);
  expect(holds("Dinner at the château")).toBe(false);
  expect(holdsAll("??")("anything")).toBe(false);
});
