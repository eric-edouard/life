import { expect, test } from "bun:test";
import type { History } from "../records/history";
import type { SourceEvent } from "../records/source";
import {
  historyWorkOf,
  type MonthCalls,
  monthCallsOf,
  newestWithin,
  partOf,
  storyInputOf,
  withMonth,
} from "./histories";
import { readPeople } from "./who";

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
  const all = [
    pending("2024-01", 1),
    pending("2026-09", 2),
    pending("2026-10", 2),
  ];
  expect(newestWithin(all, 4).map((p) => p.m.month)).toEqual([
    "2026-10",
    "2026-09",
  ]);
  // A month too big for what is left waits; a smaller, older one still goes.
  expect(newestWithin(all, 3).map((p) => p.m.month)).toEqual([
    "2026-10",
    "2024-01",
  ]);
  // A month must never be summarised without one of its sources.
  expect(
    await historyWorkOf(
      { events: [], failed: ["mail"] },
      await readPeople(),
      span
    )
  ).toBeNull();
});
