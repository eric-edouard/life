import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import { fullTextOf, type History, HistoryMonth } from "../records/history";
import {
  historyWorkOf,
  isStoryDue,
  type MonthRead,
  monthInputOf,
  monthsToReadOf,
  readHistory,
  readHistoryWork,
  storyInputOf,
  todayOf,
  twoSizesOf,
  withMonth,
} from "./histories";
import { historyPath } from "./memory-files";
import { type TimelineEntry, timelineOf } from "./person-timeline";
import { PART_CHARS } from "./read-part";
import { historyOf, person } from "./read-person-page";
import { inputsOf } from "./run";
import { readPeople } from "./who";

const UNKNOWN_SHAPE =
  /^the history memory\/histories\/test-unknown-shape\.json .*2026-09/;
const span = { from: "2026-08", today: "2026-11-11" };
const madeBy = { engine: "claude" as const, model: "m", prompt: "p", run: "r" };
const base = { built: "2026-11-11T22:00:00.000Z", inputs: "i", madeBy };
const inTwoSizes = (month: string) => ({
  ...base,
  headline: `A headline of ${month}.`,
  month,
  sentences: [{ days: [`${month}-02`], text: `Something passed in ${month}.` }],
});

/** An entry of a person's timeline; `pad` makes it long enough to count against a read part. */
const entry = (
  day: string,
  importance: number,
  text: string,
  o: Partial<TimelineEntry> = {},
  pad = 0
): TimelineEntry => ({
  day,
  importance,
  kind: "observation",
  line: `- obs_${day}_${text} ${day} news: ${text}${"x".repeat(pad)}`,
  to: day,
  ...o,
});

test("a month is in two sizes or as parts, never both, never neither", () => {
  const parts = {
    ...base,
    month: "2026-09",
    parts: [{ quotes: [], summary: "A summer." }],
  };
  expect(HistoryMonth.safeParse(inTwoSizes("2026-10")).success).toBe(true);
  expect(HistoryMonth.safeParse(parts).success).toBe(true);
  expect(
    HistoryMonth.safeParse({ ...inTwoSizes("2026-10"), parts: parts.parts })
      .success
  ).toBe(false);
  expect(HistoryMonth.safeParse({ ...base, month: "2026-10" }).success).toBe(
    false
  );
  // A sentence names at least one day; the sentences together stay a full text.
  expect(
    HistoryMonth.safeParse({
      ...inTwoSizes("2026-10"),
      sentences: [{ days: [], text: "No day." }],
    }).success
  ).toBe(false);
  expect(
    HistoryMonth.safeParse({
      ...inTwoSizes("2026-10"),
      sentences: Array.from({ length: 10 }, () => ({
        days: ["2026-10-02"],
        text: "y".repeat(500),
      })),
    }).success
  ).toBe(false);
  // The full text is derived: sentences joined, or the parts' summaries.
  expect(fullTextOf(inTwoSizes("2026-10") as never)).toBe(
    "Something passed in 2026-10."
  );
  expect(fullTextOf(parts as never)).toBe("A summer.");
});

test("a month's input holds only its days, oldest first, the most important line first, `!` on top importance, an episode's `what` shown", () => {
  const timeline = [
    entry("2026-09-30", 3, "September's last"),
    entry("2026-10-20", 2, "late", {}, 3000),
    entry("2026-10-02", 2, "ordinary", {}, 3000),
    entry("2026-10-02", 3, "decided"),
    entry("2026-10-02", 1, "episode", {
      kind: "episode",
      what: "They settled it.",
    }),
    entry("2026-11-01", 3, "November's first"),
  ];
  const read = monthInputOf(timeline, "2026-10", "Ann") as MonthRead;
  expect(read.input.with).toBe("Ann");
  expect(read.input.days.map((d) => d.day)).toEqual([
    "2026-10-02",
    "2026-10-20",
  ]);
  const lines = read.input.days[0]?.lines ?? [];
  expect(lines[0]?.startsWith("! - obs_2026-10-02_decided")).toBe(true);
  expect(lines[1]).toContain("ordinary");
  expect(lines[2]).toContain("episode");
  expect(lines[2]).toEndWith(" What happened: They settled it.");
  expect(read.input.leftOut).toBe(0);
  // What was shown and nothing else keys it: no date of today, so the clock moves nothing.
  expect(read.inputs).toBe(inputsOf("memory-history-month.v2", read.input));
  expect(JSON.stringify(read.input)).not.toContain("2026-11-1");
});

test("over the budget the least important lines go, a level's last days first, and are counted", () => {
  const timeline = [
    ...Array.from({ length: 28 }, (_, i) =>
      entry(`2026-10-${String(i + 1).padStart(2, "0")}`, 1, `low${i}`, {}, 5400)
    ),
    entry("2026-10-28", 3, "top"),
  ];
  const read = monthInputOf(timeline, "2026-10", "Ann") as MonthRead;
  const shown = read.input.days.flatMap((d) => d.lines);
  expect(read.input.leftOut).toBeGreaterThan(0);
  expect(shown.length + read.input.leftOut).toBe(29);
  expect(shown.some((l) => l.startsWith("! - obs_2026-10-28_top"))).toBe(true);
  // A level's last days go first: the first low day is kept, the last is not.
  expect(shown.some((l) => l.includes("low0"))).toBe(true);
  expect(shown.some((l) => l.includes("low27"))).toBe(false);
});

test("a month whose lines fit one read part is no month; the present month and the months before `from` are not read, `today` moved forward closes one", () => {
  const small = [entry("2026-10-02", 3, "short")];
  expect(monthInputOf(small, "2026-10", "Ann")).toBeNull();
  expect(monthInputOf([], "2026-10", "Ann")).toBeNull();
  const big = (month: string) =>
    entry(`${month}-05`, 2, "long", {}, PART_CHARS);
  const timeline = ["2026-07", "2026-09", "2026-10", "2026-11"].map(big);
  const months = (today: string) =>
    monthsToReadOf(timeline, "Ann", { from: "2026-08", today }).map(
      (m) => m.month
    );
  expect(months("2026-11-11")).toEqual(["2026-09", "2026-10"]);
  expect(months("2026-12-01")).toEqual(["2026-09", "2026-10", "2026-11"]);
});

test("the days check counts every day a shown line covers; a `(for <when>)` day is no day shown; a sentence is dropped, never moved", () => {
  const timeline = [
    entry(
      "2026-10-02",
      2,
      "trip",
      {
        kind: "episode",
        to: "2026-10-04",
      },
      3000
    ),
    entry("2026-10-09", 2, "promise (for 2026-10-20)", {}, 3000),
    // An episode spilling into the next month covers only the month's own days.
    entry("2026-10-30", 2, "late", { kind: "episode", to: "2026-11-02" }, 1000),
  ];
  const read = monthInputOf(timeline, "2026-10", "Ann") as MonthRead;
  expect(read.shownDays).toEqual([
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
    "2026-10-09",
    "2026-10-30",
    "2026-10-31",
  ]);
  const shown = new Set(read.shownDays);
  const made = twoSizesOf(
    {
      headline: "A trip and a promise.",
      sentences: [
        // The second day of a multi-day episode is valid; days not shown are cut off the sentence.
        { days: ["2026-10-03", "2026-10-20"], text: "They travelled." },
        // The `(for <when>)` day is not a shown day: nothing is left, the sentence goes.
        { days: ["2026-10-20"], text: "He will do it on the 20th." },
        { days: ["2026-10-09"], text: 'He said "I will" and meant it.' },
        { days: ["2026-10-09"], text: "He promised." },
        { days: [], text: "No day at all." },
      ],
    },
    shown
  );
  expect(made.sentences).toEqual([
    { days: ["2026-10-03"], text: "They travelled." },
    { days: ["2026-10-09"], text: "He promised." },
  ]);
  expect(made.dropped).toEqual({ days: 2, length: 0, quotes: 1, size: 0 });
  // No sentence left, or quotation marks in the headline, fails the call.
  expect(() =>
    twoSizesOf(
      { headline: "H.", sentences: [{ days: ["2026-10-20"], text: "T." }] },
      shown
    )
  ).toThrow("no sentence");
  expect(() =>
    twoSizesOf(
      {
        headline: 'He said "no".',
        sentences: [{ days: ["2026-10-02"], text: "T." }],
      },
      shown
    )
  ).toThrow("quotation marks");
  expect(() => twoSizesOf({ sentences: [] }, shown)).toThrow();
});

test("a sentence over its size, or past the size of a full text, is dropped and counted", () => {
  const shown = new Set(["2026-10-02"]);
  const sentence = (n: number) => ({
    days: ["2026-10-02"],
    text: "w".repeat(n),
  });
  const made = twoSizesOf(
    {
      headline: "H.",
      sentences: [
        sentence(700),
        ...Array.from({ length: 10 }, () => sentence(500)),
      ],
    },
    shown
  );
  expect(made.dropped).toEqual({ days: 0, length: 1, quotes: 0, size: 1 });
  expect(made.sentences).toHaveLength(9);
});

const observationsDb = () => {
  const db = new Database(":memory:");
  db.run(`create table observations (id text, unit text, date text, at text, type text, importance integer,
    confidence real, speaker text, channel text, text text, quote text, "when" text, superseded_by text)`);
  db.run("create table observation_subjects (observation text, subject text)");
  db.run("create table units (id text, title text)");
  db.run("create table unit_people (unit text, person text)");
  db.run("insert into units values ('u1', 'Chat')");
  const add = (id: string, by: string | null) => {
    db.run(
      "insert into observations values (?, 'u1', '2026-10-02', '2026-10-02T10:00:00Z', 'promise', 2, 0.9, null, 'whatsapp', ?, 'q', null, ?)",
      [id, `text of ${id}`, by]
    );
    db.run("insert into observation_subjects values (?, 'person:ann')", [id]);
  };
  return { add, db };
};
const noStore = { db: { query: () => ({ all: () => [] }) } } as never;

test("a month takes observations as they stood: one retired as history later changes neither the evidence nor the digest", () => {
  const { add, db } = observationsDb();
  add("obs_a", null);
  add("obs_b", null);
  const month = (asStood: boolean) =>
    timelineOf(db, noStore, "person:ann", [], [], asStood).map((e) => ({
      ...e,
      line: `${e.line}${"x".repeat(PART_CHARS)}`,
    }));
  const before = monthInputOf(month(true), "2026-10", "Ann") as MonthRead;
  db.run("update observations set superseded_by = 'obs_c' where id = 'obs_b'");
  const after = monthInputOf(month(true), "2026-10", "Ann") as MonthRead;
  expect(after.inputs).toBe(before.inputs);
  expect(after.input.days[0]?.lines).toHaveLength(2);
  // The person's page still shows only what is current.
  expect(timelineOf(db, noStore, "person:ann", [], [])).toHaveLength(1);
});

test("a night takes the newest months first within its calls, a month whose key is stored is not pending, and the dry count reports the largest input and the months cut", () => {
  const read = (month: string, leftOut = 0, inputs = month): MonthRead => ({
    input: { days: [], leftOut, month, with: "Ann" },
    inputs,
    month,
    shownDays: [],
  });
  const persons = [
    {
      built: new Map([["2026-08", "2026-08"]]),
      months: [read("2026-08"), read("2026-09"), read("2026-10", 3)],
      name: "Ann",
      ref: "person:ann",
    },
    {
      built: new Map(),
      months: [read("2026-10")],
      name: "Bob",
      ref: "person:bob",
    },
  ];
  const work = historyWorkOf(persons, 2, "2026-11-11");
  expect(work.counts).toMatchObject({ calls: 3, cut: 1, months: 3, people: 2 });
  expect(work.counts.largest).toBeGreaterThan(0);
  // Two calls: the two October months; Ann's September waits, so she is not whole.
  expect(
    work.work.map((w) => [w.ref, w.months.map((m) => m.month), w.isWhole])
  ).toEqual([
    ["person:ann", ["2026-10"], false],
    ["person:bob", ["2026-10"], true],
  ]);
});

test("`--today` moves the clock on a copy and is refused on his own data", () => {
  expect(todayOf(undefined, "2026-11-11", true)).toBe("2026-11-11");
  expect(todayOf("2026-12-01", "2026-11-11", false)).toBe("2026-12-01");
  expect(() => todayOf("2026-12-01", "2026-11-11", true)).toThrow(
    "his own data"
  );
  expect(() => todayOf("December", "2026-11-11", false)).toThrow("not a day");
});

test("a month read again replaces its last version; the story reads the months through the last closed year", () => {
  const month = (m: string, summary: string) => ({
    built: "2026-11-11T22:00:00.000Z",
    inputs: m,
    madeBy,
    month: m,
    parts: [{ quotes: [], summary }],
  });
  const empty: History = { months: [], schemaVersion: 1, story: null };
  const history = withMonth(
    withMonth(
      withMonth(empty, month("2026-09", "first reading")),
      month("2025-12", "a winter")
    ),
    month("2026-09", "read again")
  );
  expect(history.months.map((m) => [m.month, fullTextOf(m)])).toEqual([
    ["2025-12", "a winter"],
    ["2026-09", "read again"],
  ]);
  expect(storyInputOf(history, "Ann", "2026-11-11")).toEqual({
    months: [{ month: "2025-12", summary: "a winter" }],
    through: "2025",
    with: "Ann",
  });
});

test("a story's digest holds the months through the newest month's year, at most the last closed year: the clock alone never changes it", () => {
  const month = (m: string) => ({
    built: "2026-11-11T22:00:00.000Z",
    inputs: m,
    madeBy,
    month: m,
    parts: [{ quotes: [], summary: `in ${m}` }],
  });
  const empty: History = { months: [], schemaVersion: 1, story: null };
  const digest = (history: History, today: string) =>
    inputsOf("s", storyInputOf(history, "Ann", today));
  const old = withMonth(withMonth(empty, month("2022-04")), month("2023-06"));
  // The newest month is 2023: 1 January and 40 days later give the same story digest.
  expect(digest(old, "2026-11-11")).toBe(digest(old, "2027-01-10"));
  expect(storyInputOf(old, "Ann", "2027-01-10").through).toBe("2023");
  // A month of the closed year is new to it; one of the current year waits for the year to close.
  const last = withMonth(old, month("2025-12"));
  expect(digest(last, "2026-11-11")).not.toBe(digest(old, "2026-11-11"));
  const current = withMonth(last, month("2026-09"));
  expect(digest(current, "2026-11-11")).toBe(digest(last, "2026-11-11"));
  expect(digest(current, "2026-12-21")).toBe(digest(last, "2026-11-11"));
  expect(digest(current, "2027-01-10")).not.toBe(digest(last, "2027-01-10"));
});

test("a story is told when its months changed, never while a month of theirs still waits nor from no month", () => {
  const history: History = {
    months: [],
    schemaVersion: 1,
    story: {
      built: "2026-11-11T22:00:00.000Z",
      inputs: "told",
      madeBy,
      text: "A story.",
      through: "2025",
    },
  };
  expect(isStoryDue(history, { inputs: "changed", months: 3 }, true)).toBe(
    true
  );
  expect(isStoryDue(history, { inputs: "told", months: 3 }, true)).toBe(false);
  expect(isStoryDue(history, { inputs: "changed", months: 3 }, false)).toBe(
    false
  );
  expect(isStoryDue(history, { inputs: "changed", months: 0 }, true)).toBe(
    false
  );
});

test("a history is dated months only: each on its last day, newest first, with its summaries (its words are the month part's)", () => {
  const names = [
    ...Array.from(
      { length: 12 },
      (_, i) => `2025-${String(i + 1).padStart(2, "0")}`
    ),
    "2026-01",
    "2026-02",
  ];
  const months = names.map((month, i) => ({
    built: "2026-11-11T22:00:00.000Z",
    inputs: month,
    madeBy,
    month,
    parts: [
      {
        quotes:
          i === 13
            ? [
                {
                  at: "2026-02-03T12:00:00.000Z",
                  text: "see you Sunday",
                  writer: "them" as const,
                },
              ]
            : [],
        summary: `What passed in ${month}.`,
      },
    ],
  }));
  const history: History = {
    months,
    schemaVersion: 1,
    story: {
      built: "2026-11-11T22:00:00.000Z",
      inputs: "s",
      madeBy,
      text: "Two quiet years.",
      through: "2025",
    },
  };
  const dated = historyOf(history);
  expect(dated).toHaveLength(14);
  expect(dated[0]).toEqual({
    day: "2026-02-28",
    kind: "month",
    line: "- 2026-02 (chats and mail only): What passed in 2026-02.",
  });
  expect(dated.at(-1)?.day).toBe("2025-01-31");
  // A short month ends on its own last day (a wrong one would break the paging).
  const leap = { ...months[0], month: "2024-02" } as History["months"][number];
  expect(historyOf({ ...history, months: [leap, ...months] }).at(-1)?.day).toBe(
    "2024-02-29"
  );
  expect(historyOf({ months: [], schemaVersion: 1, story: null })).toEqual([]);
});

test("a history in a shape the code does not know is an error naming the file and the month, never an empty history a write would replace", async () => {
  expect(readHistory("person:test-nobody")).toEqual({
    months: [],
    schemaVersion: 1,
    story: null,
  });
  const ref = "person:test-unknown-shape";
  const path = historyPath(ref);
  const month = (m: string, shape: object) => ({
    built: "2026-11-11T22:00:00.000Z",
    inputs: m,
    madeBy,
    month: m,
    ...shape,
  });
  const stored = `${JSON.stringify({
    months: [
      month("2026-08", { parts: [{ quotes: [], summary: "a summer" }] }),
      month("2026-09", { headline: "a month in another shape" }),
    ],
    schemaVersion: 1,
    story: null,
  })}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stored);
  expect(() => readHistory(ref)).toThrow(UNKNOWN_SHAPE);
  // The write of a month reads first: it never happens, and the stored months stay as they were.
  const write = () =>
    withMonth(readHistory(ref), month("2026-10", { parts: [] }) as never);
  expect(write).toThrow();
  expect(readFileSync(path, "utf8")).toBe(stored);
  // What an assistant reads says so in one line, with no absolute path, rather than throwing or reading as empty.
  const said = JSON.stringify(
    await person("test-unknown-shape", { part: "story" })
  );
  expect(said).toContain("memory/histories/test-unknown-shape.json");
  expect(said).toContain("2026-09");
  expect(said).not.toContain(OWNER_DATA_DIR);
  // The night leaves that person out of its work: one error, no story call to fail again.
  const people = await readPeople();
  const work = await readHistoryWork(
    {
      ...people,
      truth: { ...people.truth, people: [{ id: "test-unknown-shape" }] },
    } as never,
    span
  );
  expect(work?.work.map((w) => w.ref) ?? []).not.toContain(ref);
  expect(readFileSync(path, "utf8")).toBe(stored);
});
