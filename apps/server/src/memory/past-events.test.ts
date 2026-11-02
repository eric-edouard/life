import { expect, test } from "bun:test";
import type { Moment } from "../records/moment";
import { type Draft, drafts, plan } from "./past-events";
import { madeBy, unit } from "./record-fixtures";

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
  units: ["unit_000000000001"],
  why: "They eat out.",
  ...over,
});

const known = {
  nameOf: (r: string) => (r === "person:bastien" ? "Bastien" : r.slice(8)),
  noted: new Map([["unit_000000000001", ["Bastien moves in March."]]]),
  units: new Map([["unit_000000000001", unit({ title: "Dinner talk" })]]),
};
const now = new Date("2026-10-21T12:00:00Z");

test("only moments that happened and ended 2 h ago go on the calendar, timed in his zone then", () => {
  const [d, ...rest] = drafts(
    [
      moment(),
      moment({ id: "mom_000000000002", status: "planned" }),
      moment({ id: "mom_000000000003", start: "2026-10-22 09:00" }),
      moment({
        end: "2026-10-21 12:30",
        id: "mom_000000000004",
        start: "2026-10-21 12:00",
      }),
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
  expect(d?.text).toContain("with Bastien; organizer Kofi.");
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

test("a sync keeps what shows as it is, rewrites what changed or doubled, deletes what is gone", () => {
  const draft = (id: string, hash: string) => ({ hash, moment: id }) as Draft;
  const { fresh, stale } = plan(
    [draft("m1", "a"), draft("m2", "a"), draft("m3", "new")],
    new Map([
      ["m1", [{ hash: "a", id: "e1" }]],
      [
        "m2",
        [
          { hash: "a", id: "e2" },
          { hash: "a", id: "e2b" },
        ],
      ],
      ["m3", [{ hash: "old", id: "e3" }]],
      ["m9", [{ hash: "a", id: "e9" }]],
    ])
  );
  expect(fresh.map((d) => d.moment)).toEqual(["m2", "m3"]);
  expect(stale.map((e) => e.id)).toEqual(["e2", "e2b", "e3", "e9"]);
});

test("a big moment keeps its event beside the smaller ones inside it (the night out dropped for a chat, 1 Nov)", () => {
  const night = moment({
    end: "2026-10-20 23:30",
    start: "2026-10-20 20:00",
    title: "Night out",
  });
  const chat = moment({
    end: "2026-10-20 21:07",
    id: "mom_000000000002",
    start: "2026-10-20 21:00",
    title: "Chat",
  });
  expect(drafts([night, chat], known, now).map((d) => d.summary)).toEqual([
    "Night out",
    "Chat",
  ]);
});
