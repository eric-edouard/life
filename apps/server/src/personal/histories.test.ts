import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newestWithin } from "../core/lists";
import { OWNER_DATA_DIR } from "../core/paths";
import { setSettings, settings } from "../core/settings";
import type { HeldSummary } from "../memory/conversation-summaries";
import { historyPath } from "../memory/memory-files";
import { OWNER } from "../memory/read-truth";
import { inputsOf } from "../memory/run";
import { readPeople } from "../memory/who";
import { localDate, time } from "../memory/zones";
import { IN_PERSON } from "../models/prompt-parts";
import type { History } from "../records/history";
import type { SourceEvent } from "../records/source";
import {
  isStoryDue,
  type MonthCalls,
  monthCallsOf,
  partOf,
  readHistory,
  readHistoryWork,
  storyInputOf,
  withMonth,
} from "./histories";
import { historyOf, readPerson } from "./person-parts";

const msg = (
  at: string,
  fromMe: boolean,
  text: string,
  extra: Partial<SourceEvent> = {}
): SourceEvent => ({
  at,
  chat: "+1",
  fromMe,
  id: at,
  sender: fromMe ? "me" : "+1",
  source: "whatsapp",
  text,
  ...extra,
});
const UNKNOWN_SHAPE =
  /^the history memory\/histories\/test-unknown-shape\.json .*2026-09/;
const span = { from: "2026-08", today: "2026-11-11" };
const madeBy = { engine: "claude" as const, model: "m", prompt: "p", run: "r" };

test("an exchange belongs to the local month it starts in; the present month and the months before `from` are not read", () => {
  const months = monthCallsOf(
    [
      msg("2026-07-10T12:00:00.000Z", true, "before the floor"),
      // One sitting from the 31st into the 1st: August's, whole.
      msg("2026-08-31T12:00:00.000Z", true, "are you coming on Sunday"),
      msg("2026-08-31T17:00:00.000Z", false, "yes, around noon"),
      msg("2026-08-31T22:00:00.000Z", true, "perfect"),
      msg("2026-09-01T03:00:00.000Z", false, "see you then"),
      msg("2026-10-05T12:00:00.000Z", false, "happy birthday"),
      msg("2026-11-02T12:00:00.000Z", true, "this month is the situation's"),
    ],
    "Ann",
    span
  );
  expect(months.map((m) => m.month)).toEqual(["2026-08", "2026-10"]);
  const [august] = months;
  expect(august?.calls).toHaveLength(1);
  expect(august?.calls[0]?.input).toMatchObject({
    month: "2026-08",
    part: 1,
    parts: 1,
    with: "Ann",
  });
  expect(august?.calls[0]?.input.lines.at(-1)).toContain("Ann: see you then");
  expect(august?.calls[0]?.input.lines[1]).toContain("me: are you coming");
});

test("a month of calls only is no month; what a month was shown decides its key", () => {
  const call = msg("2026-09-03T12:00:00.000Z", false, "audio call, 4 min", {
    phoneCall: { seconds: 240, video: false },
  });
  expect(monthCallsOf([call], "Ann", span)).toEqual([]);
  const said = msg("2026-09-03T13:00:00.000Z", true, "sorry, I missed you");
  const [month] = monthCallsOf([call, said], "Ann", span);
  // The call's line is shown, never quotable.
  expect(month?.calls[0]?.input.lines.join("\n")).toContain("audio call");
  expect(month?.calls[0]?.quotable).toEqual([said]);
  // The same messages give the same key; a late message moves it, and the month is read again once.
  expect(monthCallsOf([call, said], "Ann", span)[0]?.inputs).toBe(
    month?.inputs
  );
  const late = msg("2026-09-20T12:00:00.000Z", false, "found in a backup");
  expect(monthCallsOf([call, said, late], "Ann", span)[0]?.inputs).not.toBe(
    month?.inputs
  );
});

test("a conversation in person sits among the exchanges by time and switches on its prompt part; a month with none is shown as before", () => {
  const stream = [
    msg("2026-09-03T12:00:00.000Z", false, "lunch on Friday?"),
    msg("2026-09-03T12:05:00.000Z", true, "yes, at noon"),
    msg("2026-09-20T09:00:00.000Z", true, "thanks for Friday"),
  ];
  const [plain] = monthCallsOf(stream, "Ann", span);
  // Its key as it was before conversations in person were read: its stored reading stands, never read again.
  expect(plain?.inputs).toBe("1d50feb189a5b51c");
  expect(plain?.calls[0]?.parts).toEqual([]);
  const talk = {
    at: "2026-09-05T11:00:00.000Z",
    summary: "They talked about the move.",
  };
  const [month] = monthCallsOf(stream, "Ann", span, [talk]);
  const [call] = month?.calls ?? [];
  expect(call?.input.lines.slice(3, 6)).toEqual([
    `## In person · 2026-09-05 ${time(talk.at)}`,
    "They talked about the move.",
    "## Exchange 2 · 2026-09-20",
  ]);
  expect(call?.input.lines.at(-1)).toStartWith("[2] ");
  expect(call?.parts).toEqual([IN_PERSON]);
  // Quotes are looked for in the messages only, never in a summary.
  expect(call?.quotable).toEqual(stream);
  expect(month?.inputs).not.toBe(plain?.inputs);
  // A month they only talked in person is a month.
  expect(
    monthCallsOf([], "Ann", span, [talk]).map((m) => [
      m.month,
      m.calls[0]?.quotable,
    ])
  ).toEqual([["2026-09", []]]);
});

test("a conversation in person goes to each person heard in it, never to him", async () => {
  const people = await readPeople();
  const resolve = (s: string) =>
    ({ Ann: "person:test-ann", "p-me": OWNER })[s] ?? null;
  const talk = {
    at: "2026-09-05T11:00:00.000Z",
    // A voice wrongly named after him is never his own history.
    speakers: [
      { id: null, name: "Ann" },
      { id: "p-me", name: null },
    ],
    summary: "They talked about the move.",
  } as HeldSummary;
  const work = await readHistoryWork(
    { events: [], failed: [] },
    {
      ...people,
      resolve,
      truth: { ...people.truth, people: [{ id: "test-ann" }, { id: "bo" }] },
    } as never,
    span,
    () => Promise.resolve([talk])
  );
  const monthsOf = (ref: string) =>
    work?.work.find((w) => w.ref === ref)?.months.map((m) => m.month);
  expect(monthsOf("person:test-ann")).toEqual(["2026-09"]);
  expect(monthsOf("person:bo")).toEqual([]);
  expect(monthsOf(OWNER)).toEqual([]);
});

test("a part keeps only quotes found in a message shown, with time and writer; quotation marks in a summary fail the call", () => {
  const shown = [
    msg("2026-09-03T12:00:00.000Z", false, "I can't keep doing this alone"),
    msg("2026-09-03T12:05:00.000Z", true, "ok"),
  ];
  expect(
    partOf(
      {
        quotes: ["i can't keep doing this alone", "words never written"],
        summary: "She asked for help and he agreed.",
      },
      shown
    )
  ).toEqual({
    quotes: [
      {
        at: "2026-09-03T12:00:00.000Z",
        text: "I can't keep doing this alone",
        writer: "them",
      },
    ],
    summary: "She asked for help and he agreed.",
  });
  // A month of short messages has nothing long enough to find: the part is kept, with no quote.
  expect(partOf({ summary: "Brief logistics." }, shown).quotes).toEqual([]);
  expect(() =>
    partOf({ summary: 'She said "never again" and left.' }, shown)
  ).toThrow("quotation marks");
  expect(() => partOf({ summary: "" }, shown)).toThrow();
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
  expect(history.months.map((m) => [m.month, m.parts[0]?.summary])).toEqual([
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

test("a night takes the newest months first, within its calls; a failed source reads nothing", async () => {
  const pending = (month: string, calls: number) => ({
    m: { calls: new Array(calls).fill({}), inputs: month, month } as MonthCalls,
  });
  const byMonth = {
    at: (p: ReturnType<typeof pending>) => p.m.month,
    size: (p: ReturnType<typeof pending>) => p.m.calls.length,
  };
  const all = [
    pending("2024-01", 1),
    pending("2026-09", 2),
    pending("2026-10", 2),
  ];
  expect(newestWithin(all, 4, byMonth).map((p) => p.m.month)).toEqual([
    "2026-10",
    "2026-09",
  ]);
  // A month too big for what is left waits; a smaller, older one still goes.
  expect(newestWithin(all, 3, byMonth).map((p) => p.m.month)).toEqual([
    "2026-10",
    "2024-01",
  ]);
  // A month must never be summarised without one of its sources.
  expect(
    await readHistoryWork(
      { events: [], failed: ["mail"] },
      await readPeople(),
      span
    )
  ).toBeNull();
});

test("a month is his local month, never the UTC one: late on the 31st in UTC is already the 1st where he is", () => {
  // The test data has him east of UTC then (the fixture's zones).
  const at = "2026-10-31T23:30:00.000Z";
  expect(localDate(at)).toBe("2026-11-01");
  const [month] = monthCallsOf(
    [msg(at, true, "made it home, thanks for tonight")],
    "Ann",
    { from: "2026-08", today: "2026-12-11" }
  );
  expect(month?.month).toBe("2026-11");
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
    line: "- 2026-02: What passed in 2026-02.",
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
  const was = settings().personal;
  setSettings({ personal: { histories: { from: "2026-01" } } });
  let said = "";
  try {
    said = JSON.stringify(
      await readPerson("test-unknown-shape", { part: "story" })
    );
  } finally {
    setSettings({ personal: was ?? null });
  }
  expect(said).toContain("memory/histories/test-unknown-shape.json");
  expect(said).toContain("2026-09");
  expect(said).not.toContain(OWNER_DATA_DIR);
  // The night leaves that person out of its work: one error, no story call to fail again.
  const people = await readPeople();
  const work = await readHistoryWork(
    { events: [], failed: [] },
    {
      ...people,
      truth: { ...people.truth, people: [{ id: "test-unknown-shape" }] },
    } as never,
    span
  );
  expect(work?.work.map((w) => w.ref)).not.toContain(ref);
  expect(readFileSync(path, "utf8")).toBe(stored);
});
