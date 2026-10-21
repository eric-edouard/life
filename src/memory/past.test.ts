import { expect, test } from "bun:test";
import type { Moment } from "../schema";
import { madeBy, unit } from "./fixtures";
import { drafts } from "./past";

const moment = (over: Partial<Moment> = {}): Moment => ({
  copies: [],
  day: "2026-10-20",
  end: "2026-10-20 21:30",
  id: "mom_000000000001",
  importance: 1,
  madeBy,
  people: [
    { ref: "person:bastien", role: "with" },
    { ref: "unknown:Kofi", role: "organizer" },
  ],
  place: null,
  schemaVersion: 1,
  start: "2026-10-20 20:00",
  status: "happened",
  title: "Dinner with Bastien",
  units: ["u_000000000001"],
  why: "They eat out.",
  ...over,
});

const known = {
  names: new Map([["person:bastien", "Bastien"]]),
  noted: new Map([["u_000000000001", ["Bastien moves in March."]]]),
  refOf: (r: string) => r,
  units: new Map([["u_000000000001", unit({ title: "Dinner talk" })]]),
};
const now = new Date("2026-10-21T12:00:00Z");

test("only moments that happened and have started go on the calendar, timed in his zone then", () => {
  const [d, ...rest] = drafts(
    [
      moment(),
      moment({ id: "mom_000000000002", status: "planned" }),
      moment({ id: "mom_000000000003", start: "2026-10-22 09:00" }),
    ],
    known,
    now
  );
  expect(rest).toEqual([]);
  // Africa/Lagos (UTC+1) from 19 Oct in the test zones.
  expect(d).toMatchObject({
    allDay: false,
    from: "2026-10-20T19:00:00.000Z",
    moment: "mom_000000000001",
    to: "2026-10-20T20:30:00.000Z",
  });
  expect(d?.text).toContain("With: Bastien, Kofi (organizer)");
  expect(d?.text).toContain("- Bastien moves in March.");
  expect(d?.text).toContain("Dinner talk");
});

test("no time is a whole day, no end an hour, and the hash follows what is shown", () => {
  const [day] = drafts(
    [moment({ end: null, start: "2026-10-19" })],
    known,
    now
  );
  expect(day).toMatchObject({
    allDay: true,
    from: "2026-10-19",
    to: "2026-10-20",
  });
  const [open] = drafts([moment({ end: null })], known, now);
  expect(open?.to).toBe("2026-10-20T20:00:00.000Z");
  const [a] = drafts([moment()], known, now);
  const [b] = drafts(
    [moment({ title: "Dinner with Bastien and Kofi" })],
    known,
    now
  );
  expect(a?.hash).toBe(drafts([moment()], known, now)[0]?.hash as string);
  expect(a?.hash).not.toBe(b?.hash);
});
