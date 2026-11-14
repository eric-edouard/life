import { expect, test } from "bun:test";
import { newestWithin } from "../core/lists";
import type { History } from "../records/history";
import type { SourceEvent } from "../records/source";
import {
  isStoryDue,
  type MonthCalls,
  monthCallsOf,
  partOf,
  readHistoryWork,
  storyInputOf,
  withMonth,
} from "./histories";
import { historyOf } from "./read-person-page";
import { readPeople } from "./who";
import { localDate } from "./zones";

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
