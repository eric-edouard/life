import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import { episodesOf, mentionsByUnit, timelineOf } from "./person-timeline";

const episode = (id: string, people: string[], units: string[]) =>
  ({
    copies: [],
    day: "2026-10-02",
    end: "2026-10-03 10:00",
    id,
    importance: 2,
    people: people.map((ref) => ({ ref, role: "with" })),
    place: null,
    start: "2026-10-02 19:00",
    title: `Title of ${id}`,
    units,
    what: `What happened in ${id}.`,
    within: null,
  }) as unknown as Episode;

test("an episode that only talked about the person is in their timeline, labelled; one they are in is not", () => {
  const all = [
    episode("ep_there", ["person:ann"], ["u1"]),
    episode("ep_talked", ["person:bob"], ["u2"]),
    episode("ep_other", ["person:bob"], ["u3"]),
  ];
  const talked = new Map([["ep_talked", ["person:ann"]]]);
  const mine = episodesOf(all, "person:ann", (r) => r, talked);
  expect(mine.map((e) => [e.episode.id, e.isThere])).toEqual([
    ["ep_there", true],
    ["ep_talked", false],
  ]);
  const db = new Database(":memory:");
  db.run(`create table observations (id text, unit text, date text, at text, type text, importance integer,
    confidence real, speaker text, channel text, text text, quote text, "when" text, superseded_by text)`);
  db.run("create table observation_subjects (observation text, subject text)");
  db.run("create table units (id text, title text)");
  db.run("create table unit_people (unit text, person text)");
  const noStore = { db: { query: () => ({ all: () => [] }) } } as never;
  const timeline = timelineOf(db, noStore, "person:ann", mine, []);
  expect(timeline.map((e) => e.kind)).toEqual(["episode", "episode"]);
  const there = timeline.find((e) => e.line.includes("ep_there"));
  const told = timeline.find((e) => e.line.includes("ep_talked"));
  expect(there?.line).not.toContain("talked about");
  expect(told?.line).toEndWith(" (they were talked about, not there)");
  // What happened and the whole span travel with the entry; the line holds neither.
  expect(told).toMatchObject({
    day: "2026-10-02",
    importance: 2,
    to: "2026-10-03",
    what: "What happened in ep_talked.",
  });
  expect(told?.line).not.toContain("What happened");
});

test("the kept mentions are grouped by the unit they were found in", () => {
  const m = (unit: string) => ({
    at: "",
    by: "",
    line: "",
    quote: "",
    unit,
    who: "",
  });
  const byUnit = mentionsByUnit({
    "2026-10-02": [m("u1"), m("u2")],
    "2026-10-03": [m("u1")],
  });
  expect(byUnit.get("u1")).toHaveLength(2);
  expect(mentionsByUnit(null).size).toBe(0);
});
