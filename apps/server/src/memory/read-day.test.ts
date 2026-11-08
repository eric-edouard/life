import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import { episodeLine } from "./index-rows";
import { dayLines, shownEpisode } from "./read-day";

test("day: its key observations in no episode, then its units, a recorded conversation among them", () => {
  const lines = dayLines({
    facts: ['- obs_1 2026-10-14 todo: Call the glazier "call him"'],
    units: [
      {
        date: "2026-10-14",
        id: "unit_000000000001",
        source: "whatsapp",
        title: "Team",
        topics: "glass",
      },
      {
        date: "2026-10-14",
        id: "unit_000000000002",
        source: "lifelog",
        title: "Recorded conversation",
        topics: "plumbing",
      },
    ],
  });
  expect(lines).toContain("Units (2; `fetch <unit id>`):");
  expect(lines).toContain(
    "- unit_000000000002 2026-10-14 lifelog: Recorded conversation [plumbing]"
  );
  expect(lines).toContain(
    "- unit_000000000001 2026-10-14 whatsapp: Team [glass]"
  );
  expect(lines.slice(0, 2)).toEqual([
    "Key observations in no episode:",
    '- obs_1 2026-10-14 todo: Call the glazier "call him"',
  ]);
});

test("a fact sits under the episode shown that reads its unit; one read by an episode not shown sits under none", () => {
  const dinner = { id: "ep_000000000001" } as Episode;
  const later = { id: "ep_000000000002" } as Episode;
  const of = shownEpisode(
    new Map([
      ["unit_000000000001", dinner],
      ["unit_000000000002", later],
    ]),
    new Set([dinner])
  );
  expect(of("unit_000000000001")).toBe(dinner);
  expect(of("unit_000000000002")).toBeUndefined();
  expect(of("unit_000000000003")).toBeUndefined();
});

test("a day opens with what he did: its episodes in plain words, where he was, what happened and their facts; units worth nothing only counted", () => {
  const m = {
    day: "2026-10-15",
    end: null,
    id: "ep_000000000001",
    people: [
      { ref: "person:bastien", role: "with" },
      { ref: "unknown:Cédric", role: "with" },
    ],
    place: "Claire's house",
    start: "2026-10-16 16:20",
    title: "Road trip to see the sisters with Bastien",
    units: ["unit_000000000001"],
    what: "They drove to Rouen.",
  } as Episode;
  expect(episodeLine(m)).toStartWith(
    "- ep_000000000001 Road trip to see the sisters with Bastien, 16 Oct"
  );
  expect(episodeLine(m)).toEndWith(
    ", at Claire's house; with bastien, Cédric. [unit_000000000001]"
  );
  const unit = (id: string, importance: number | null) => ({
    date: "2026-10-16",
    id,
    importance,
    source: "whatsapp" as const,
    title: "Sisters",
    topics: "",
  });
  expect(
    dayLines({
      episodes: [
        { episode: m, facts: ["- obs_1 a fact of the trip"], stay: "Rouen" },
      ],
      facts: ["- obs_2 a fact in no episode"],
      units: [unit("unit_000000000001", 2), unit("unit_000000000002", 0)],
      whereUnknown: false,
    })
  ).toEqual([
    "Episodes (what he did, in time order):",
    episodeLine(m),
    "    Where he was: Rouen",
    "    They drove to Rouen.",
    "    - obs_1 a fact of the trip",
    "",
    "Key observations in no episode:",
    "- obs_2 a fact in no episode",
    "",
    "Units (2; `fetch <unit id>`; 1 worth nothing not listed):",
    "- unit_000000000001 2026-10-16 whatsapp: Sisters",
  ]);
  expect(
    dayLines({ episodes: [{ episode: m, facts: [] }], whereUnknown: true })
  ).toContain("Where he was is unknown: lifelog could not be read.");
  expect(dayLines({})[0]).toStartWith("Units (0;");
});
