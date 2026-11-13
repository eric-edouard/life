import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Episode } from "../records/episode";
import type { Observation } from "../records/observation";
import { buildIndex } from "./index-writer";
import { EPISODES, INDEX, readBy, UNITS } from "./memory-files";
import { drafts, wanted } from "./past-events";
import { madeBy, unit } from "./record-fixtures";

const episode = (over: Partial<Episode> = {}): Episode => ({
  copies: [],
  day: "2026-10-20",
  end: "2026-10-20 21:30",
  id: "ep_000000000001",
  importance: 1,
  madeBy,
  people: [
    { ref: "person:bastien", role: "with" },
    { ref: "unknown:Kofi", role: "organizer" },
  ],
  place: null,
  schemaVersion: 1,
  start: "2026-10-20 20:00",
  title: "Dinner with Bastien",
  units: ["unit_000000000001"],
  what: "They eat out.",
  within: null,
  ...over,
});

const known = {
  nameOf: (r: string) => (r === "person:bastien" ? "Bastien" : r.slice(8)),
  noted: new Map([["unit_000000000001", ["Bastien moves in March."]]]),
  units: new Map([["unit_000000000001", unit({ title: "Dinner talk" })]]),
};
const now = new Date("2026-10-21T12:00:00Z");
const draftsOf = (eps: Episode[]) =>
  drafts(eps, { ...known, byEpisode: readBy(eps) }, now);

test("episodes that ended 2 h ago go on the calendar, timed in his zone then, what happened first; a fact sits under its unit's episode only", () => {
  const [d, trip, ...rest] = draftsOf([
    episode(),
    // The trip holding the dinner: the dinner's fact is the dinner's (`readBy`).
    episode({
      end: "2026-10-20 23:00",
      id: "ep_000000000002",
      place: "Lille",
      start: "2026-10-20 08:00",
      title: "Trip to Lille",
      units: ["unit_000000000001", "unit_000000000002"],
    }),
    episode({
      id: "ep_000000000003",
      start: "2026-10-22 09:00",
      units: ["unit_000000000003"],
    }),
    episode({
      end: "2026-10-21 12:30",
      id: "ep_000000000004",
      start: "2026-10-21 12:00",
      units: ["unit_000000000004"],
    }),
  ]);
  expect(rest).toEqual([]);
  expect(trip?.text).not.toContain("Bastien moves in March.");
  expect(trip?.summary).toBe("Trip to Lille");
  // Africa/Lagos (UTC+1) from 19 Oct in the test zones.
  expect(d).toMatchObject({
    allDay: false,
    from: "2026-10-20T19:00:00.000Z",
    of: "ep_000000000001",
    to: "2026-10-20T20:30:00.000Z",
  });
  expect(d?.text).toStartWith("They eat out.");
  expect(d?.text).toContain("with Bastien; organizer Kofi.");
  expect(d?.text).toContain("- Bastien moves in March.");
  expect(d?.text).toContain("Dinner talk");
});

test("no time is a whole day, no end an hour, and the hash follows what is shown", () => {
  const [day] = draftsOf([episode({ end: null, start: "2026-10-19" })]);
  expect(day).toMatchObject({
    allDay: true,
    from: "2026-10-19",
    to: "2026-10-20",
  });
  const [open] = draftsOf([episode({ end: null })]);
  expect(open?.to).toBe("2026-10-20T20:00:00.000Z");
  const [a] = draftsOf([episode()]);
  const [b] = draftsOf([episode({ title: "Dinner with Bastien and Kofi" })]);
  expect(a?.hash).toBe(draftsOf([episode()])[0]?.hash as string);
  expect(a?.hash).not.toBe(b?.hash);
});

test("a big episode keeps its event beside the smaller ones inside it (the night out dropped for a chat, 1 Nov)", () => {
  const night = episode({
    end: "2026-10-20 23:30",
    start: "2026-10-20 20:00",
    title: "Night out",
  });
  const chat = episode({
    end: "2026-10-20 21:07",
    id: "ep_000000000002",
    start: "2026-10-20 21:00",
    title: "Chat",
  });
  expect(draftsOf([night, chat]).map((d) => d.summary)).toEqual([
    "Night out",
    "Chat",
  ]);
});

test("a sync of recent days drafts what the whole sync drafts of the episodes ending after its start", async () => {
  const line = (over: Partial<Episode>) => `${JSON.stringify(episode(over))}\n`;
  // ep 2 was read on two days: its old line's units come along.
  const days = {
    "2026-10-18": [
      line({
        day: "2026-10-18",
        end: "2026-10-18 21:00",
        start: "2026-10-18 20:00",
      }),
      line({
        day: "2026-10-18",
        id: "ep_000000000002",
        units: ["unit_000000000002"],
      }),
    ],
    "2026-10-20": [
      line({ id: "ep_000000000002", units: ["unit_000000000003"] }),
    ],
  };
  const units = {
    "2026-10-18": ["unit_000000000001", "unit_000000000002"],
    "2026-10-20": ["unit_000000000003"],
  };
  mkdirSync(EPISODES, { recursive: true });
  mkdirSync(UNITS, { recursive: true });
  mkdirSync(dirname(INDEX), { recursive: true });
  try {
    for (const [day, lines] of Object.entries(days)) {
      writeFileSync(join(EPISODES, `${day}.jsonl`), lines.join(""));
    }
    for (const [date, ids] of Object.entries(units)) {
      writeFileSync(
        join(UNITS, `${date}.jsonl`),
        ids.map((id) => `${JSON.stringify(unit({ date, id }))}\n`).join("")
      );
    }
    const noted = (n: number) =>
      ({
        date: "2026-10-18",
        id: `obs_${n}`,
        source: { channel: "lifelog", ref: "x" },
        subjects: [],
        text: `Fact ${n}.`,
        unit: `unit_00000000000${n}`,
      }) as unknown as Observation;
    buildIndex([noted(1), noted(2), noted(3)], INDEX, {
      corrections: [],
      latest: new Map(),
      live: new Set(),
      retired: new Map(),
    });
    const since = new Date("2026-10-19T00:00:00Z");
    const recent = await wanted(now, since);
    const whole = await wanted(now);
    expect(recent?.drafts.map((d) => d.of)).toEqual(["ep_000000000002"]);
    expect(recent?.drafts[0]?.text).toContain("Fact 2.");
    expect(recent?.drafts).toEqual(
      whole?.drafts.filter((d) => Date.parse(d.to) > since.getTime())
    );
    expect(recent?.live).toEqual(whole?.live as Set<string>);
  } finally {
    rmSync(EPISODES, { force: true, recursive: true });
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});
