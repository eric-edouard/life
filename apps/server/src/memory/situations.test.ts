import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { writeJson } from "../core/files";
import type { Episode } from "../records/episode";
import { situationPath } from "./memory-files";
import { inputsOf } from "./run";
import {
  isRecent,
  readSituationNow,
  shownLines,
  situationBlock,
  situationEpisodesOf,
  situationInputOf,
} from "./situations";

const REF = "person:test-ana";
const A = "ep_aaaaaaaaaaaa";
const B = "ep_bbbbbbbbbbbb";

afterEach(() => rm(situationPath(REF), { force: true }));

test("a reply keeps only lines citing episodes it was shown", () => {
  const reply = {
    lines: [
      { cites: [A], text: "Ana and the owner broke up before 3 Mar." },
      { cites: [A, B], text: "Cites one episode it was not shown." },
      { cites: [], text: "Cites nothing." },
      { text: "No cites at all." },
    ],
  };
  expect(shownLines(reply, new Set([A]))).toEqual([
    { cites: [A], text: "Ana and the owner broke up before 3 Mar." },
  ]);
  expect(shownLines("not json", new Set([A]))).toEqual([]);
});

test("a reader shows only lines whose episodes are still live", () => {
  writeJson(situationPath(REF), {
    built: "2026-11-05T00:00:00.000Z",
    inputs: "0123456789abcdef",
    lines: [
      { cites: [A], text: "Ana stays at his flat since 20 Mar." },
      { cites: [B], text: "An episode since re-read away." },
    ],
    madeBy: { engine: "claude", model: "m", prompt: "p", run: "r" },
    page: REF,
    schemaVersion: 1,
  });
  expect(
    situationBlock("Situation", readSituationNow(REF, new Set([A])))
  ).toEqual([
    "Situation (where things stand, read each night from the 30 days up to their newest episode):",
    `- Ana stays at his flat since 20 Mar. [${A}]`,
    "",
  ]);
  expect(situationBlock("Situation", readSituationNow(REF, new Set()))).toEqual(
    []
  );
});

const ep = (n: number, day: string, who: string, importance = 2) =>
  ({
    copies: [],
    day,
    id: `ep_${String(n).padStart(12, "a")}`,
    importance,
    people: [{ ref: who, role: "with" }],
    start: day,
    title: `Title ${n}`,
    units: [],
    what: `What ${n}.`,
  }) as unknown as Episode;

test("a situation's digest is its subject's weighty episodes ending at their newest: the clock changes nothing, a new episode of theirs does", () => {
  const ana = "person:ana";
  const digest = (list: Episode[]) =>
    inputsOf(
      "p",
      situationInputOf(
        situationEpisodesOf(list, (m) => m.people[0]?.ref === ana),
        (ref) => ref
      )
    );
  const all = [
    ep(1, "2026-08-01", ana),
    ep(2, "2026-10-20", ana),
    ep(3, "2026-10-25", ana),
    ep(4, "2026-11-10", "person:bo"),
  ];
  const before = digest(all);
  // The window of 30 days ends at her newest episode: the August one is out of it, and stays out as days pass.
  expect(
    situationEpisodesOf(all, (m) => m.people[0]?.ref === ana).map((m) => m.day)
  ).toEqual(["2026-10-20", "2026-10-25"]);
  // Today moving 40 days: the same episodes, so the same digest; only who has a situation looks at the date.
  const eps = situationEpisodesOf(all, (m) => m.people[0]?.ref === ana);
  expect(isRecent(eps, "2026-11-14")).toBe(true);
  expect(isRecent(eps, "2026-12-25")).toBe(false);
  // A low-importance episode of hers, or an episode of someone else, changes nothing.
  expect(digest([...all, ep(5, "2026-11-01", ana, 1)])).toBe(before);
  expect(digest([...all, ep(6, "2026-11-12", "person:bo")])).toBe(before);
  // A new weighty episode of hers does.
  expect(digest([...all, ep(7, "2026-11-12", ana)])).not.toBe(before);
});
