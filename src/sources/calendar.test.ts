import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlan } from "./calendar";
import { toAppleS } from "./imessage";

const ACCOUNT = "someone@example.com";
const apple = (iso: string) => toAppleS(Date.parse(iso));

/** A Calendar database with the columns `readPlan` reads: his main calendar (1) and a shared one (2). */
function calendarFixture(
  items: [string, string, string, string, number?, number?, number?][]
) {
  const path = join(mkdtempSync(join(tmpdir(), "cal-")), "Calendar.sqlitedb");
  const db = new Database(path);
  db.run("create table Calendar (ROWID integer primary key, external_id text)");
  db.run(
    "create table CalendarItem (summary text, description text, start_date real, end_date real, all_day integer, calendar_id integer, status integer, hidden integer)"
  );
  db.run(
    `insert into Calendar values (1, '/caldav/v2/${encodeURIComponent(ACCOUNT)}/events/'), (2, '/caldav/v2/shared%40group.calendar.google.com/events/')`
  );
  for (const [
    title,
    description,
    start,
    end,
    calendar = 1,
    status = 1,
    allDay = 0,
  ] of items) {
    db.run("insert into CalendarItem values (?, ?, ?, ?, ?, ?, ?, 0)", [
      title,
      description,
      apple(start),
      apple(end),
      allDay,
      calendar,
      status,
    ]);
  }
  db.close();
  return path;
}

test("the plan is his main calendar's #plan blocks in the range, by start: not his other events, a shared calendar's or a cancelled one", () => {
  const path = calendarFixture([
    ["Focus", "#plan", "2026-10-14T07:00:00Z", "2026-10-14T10:00:00Z"],
    [
      "Workout",
      "Morning.\n#plan",
      "2026-10-14T05:00:00Z",
      "2026-10-14T06:00:00Z",
    ],
    [
      "Free time",
      "#plan",
      "2026-10-18T00:00:00Z",
      "2026-10-19T00:00:00Z",
      1,
      1,
      1,
    ],
    [
      "Train",
      "Booked in Gmail",
      "2026-10-14T12:00:00Z",
      "2026-10-14T15:00:00Z",
    ],
    [
      "Couple dinner",
      "#plan",
      "2026-10-14T18:00:00Z",
      "2026-10-14T20:00:00Z",
      2,
    ],
    [
      "Cancelled focus",
      "#plan",
      "2026-10-15T07:00:00Z",
      "2026-10-15T10:00:00Z",
      1,
      3,
    ],
    ["Next week", "#plan", "2026-10-21T07:00:00Z", "2026-10-21T08:00:00Z"],
  ]);
  const plan = readPlan(
    new Date("2026-10-12T00:00:00Z"),
    new Date("2026-10-19T00:00:00Z"),
    ACCOUNT,
    path
  );
  expect(plan).toEqual([
    {
      allDay: false,
      end: "2026-10-14T06:00:00.000Z",
      start: "2026-10-14T05:00:00.000Z",
      title: "Workout",
    },
    {
      allDay: false,
      end: "2026-10-14T10:00:00.000Z",
      start: "2026-10-14T07:00:00.000Z",
      title: "Focus",
    },
    {
      allDay: true,
      end: "2026-10-19T00:00:00.000Z",
      start: "2026-10-18T00:00:00.000Z",
      title: "Free time",
    },
  ]);
});

test("with no account set there is no plan to read, and the database is not opened", () => {
  expect(
    readPlan(new Date(), new Date(), "", "/nowhere/Calendar.sqlitedb")
  ).toBeNull();
});
