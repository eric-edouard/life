import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJson } from "../core/files";
import type { Observation } from "../records/observation";
import type { Unit } from "../records/unit";
import { buildIndex, reindexUnits } from "./index-writer";
import { situationPath } from "./ledger";
import { dayLines } from "./read-day";
import { dueOf } from "./read-open-items";
import { heldLines } from "./read-person-page";
import { OWNER } from "./read-truth";
import { readSituationsOf, matches as searchMatches } from "./search";

test("search: an observation hit names the unit it comes from and who is in it", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "life-search-")), "i.sqlite");
  const o = {
    at: "2026-10-14T10:01:00.000Z",
    date: "2026-10-14",
    entities: ["project:photo-app"],
    id: "obs_1",
    importance: 2,
    quote: "il est à rework",
    source: { channel: "lifelog", ref: "j:0@x" },
    text: "Jean will rework the photo-app beautify prompt.",
    type: "to_do",
    unit: "unit_000000000001",
  } as unknown as Observation;
  const unit = {
    date: "2026-10-14",
    id: "unit_000000000001",
    people: ["person:jerome", "unknown:Bob"],
    source: "lifelog",
    title: "Improving output prompts before advertising tests",
  } as unknown as Unit;
  const standing = {
    corrections: [],
    latest: new Map(),
    live: new Set([unit.id]),
    retired: new Map(),
  };
  buildIndex([o], path, standing, [{ unit }]);
  const db = new Database(path, { readonly: true });
  const [hit] = searchMatches(db, "beautify");
  expect(hit).toEndWith(
    '(lifelog "Improving output prompts before advertising tests"; jerome, Bob)'
  );
  // A handle held across a rebuild reads the new index (one held across a file swap failed).
  buildIndex([{ ...o, text: "Jean will polish the prompt." }], path, standing);
  expect(searchMatches(db, "beautify")).toEqual(["(nothing found)"]);
  expect(searchMatches(db, "polish")[0]).toContain("polish the prompt");
  // A table no schema has any more goes at the next rebuild.
  const writer = new Database(path);
  writer.run("create table stale (x)");
  writer.close();
  buildIndex([o], path, standing, [{ unit }]);
  expect(
    db.query("select name from sqlite_schema where name = 'stale'").get()
  ).toBeNull();
  // A rebuild that fails leaves the last index whole.
  expect(() =>
    buildIndex(
      [{ ...o, source: undefined } as unknown as Observation],
      path,
      standing
    )
  ).toThrow();
  expect(searchMatches(db, "beautify")[0]).toBe(hit);
  // A unit's people are kept once each: the index takes them as reindex maps them today (two refs may fold into one).
  buildIndex([o], path, standing, [
    { unit: { ...unit, people: ["person:jerome", "person:jerome"] } },
  ]);
  expect(
    db.query("select person from unit_people where unit = ?").all(unit.id)
  ).toEqual([{ person: "person:jerome" }]);
  buildIndex([o], path, standing, [{ unit }]);
  // `from`/`to` bound observations and units too, both days included.
  expect(searchMatches(db, "beautify", { from: "2026-10-14" })[0]).toBe(hit);
  expect(searchMatches(db, "beautify", { to: "2026-10-14" })[0]).toBe(hit);
  expect(searchMatches(db, "beautify", { from: "2026-10-15" })).toEqual([
    "(nothing found)",
  ]);
  expect(searchMatches(db, "beautify", { to: "2026-10-13" })).toEqual([
    "(nothing found)",
  ]);
  // What Life holds about someone: by source and by month, and what it can't hold.
  const cover = heldLines(db, "person:jerome", []);
  expect(cover).toContain(
    "- lifelog: 1 units, 2026-10-14 to 2026-10-14 (Life holds it since 2026-10-14)"
  );
  // The pendant's other days of the month, from its first day on: lifelog was never asked, so nobody can tell.
  expect(cover).toContain(
    "- 2026-10: 1 units (lifelog 1), 0 observations, 0 episodes; unknown: lifelog 17 days"
  );
  expect(cover.at(-1)).toContain("calls");
  // A unit rewritten in place takes its rows alone: the observations stay.
  await reindexUnits([{ ...unit, title: "Plumbing call" }], path);
  expect(searchMatches(db, "beautify")[0]).toContain('lifelog "Plumbing call"');
  expect(db.query("select count(*) as n from units").get()).toEqual({ n: 1 });
  db.close();
});

test("a search opens with his situation when it names no one, then others' lines on the episodes it shows", async () => {
  const [ep, other] = ["ep_00000000000a", "ep_00000000000b"];
  const ANA = "person:test-ana";
  const write = (page: string, lines: { cites: string[]; text: string }[]) =>
    writeJson(situationPath(page), {
      built: "2026-11-05T00:00:00.000Z",
      inputs: "0123456789abcdef",
      lines,
      madeBy: { engine: "claude", model: "m", prompt: "p", run: "r" },
      page,
      schemaVersion: 1,
    });
  write(OWNER, [
    { cites: [ep], text: "He argues with his father about the house." },
  ]);
  write(ANA, [
    { cites: [ep], text: "Ana helps with the house." },
    { cites: [other], text: "Ana moved flats." },
  ]);
  const live = new Set([ep, other]);
  const header = "(where things stand, read each night from the last 30 days):";
  try {
    await expect(
      readSituationsOf("what bothers me lately", live, new Set([ep]), true)
    ).resolves.toEqual([
      `His situation ${header}`,
      `- He argues with his father about the house. [${ep}]`,
      "",
      `Situation with Test Ana, on the episodes below ${header}`,
      `- Ana helps with the house. [${ep}]`,
      "",
    ]);
    // A search into given days is not about now: his own shows only where it cites what was found, like anyone's.
    await expect(
      readSituationsOf("what bothers me lately", live, new Set([other]), false)
    ).resolves.toEqual([
      `Situation with Test Ana, on the episodes below ${header}`,
      `- Ana moved flats. [${other}]`,
      "",
    ]);
    // A person named shows whole; his own then shows only where it cites what was found.
    await expect(
      readSituationsOf("how is test ana", live, new Set([ep]), true)
    ).resolves.toEqual([
      `Situation with Test Ana ${header}`,
      `- Ana helps with the house. [${ep}]`,
      `- Ana moved flats. [${other}]`,
      "",
      `His situation, on the episodes below ${header}`,
      `- He argues with his father about the house. [${ep}]`,
      "",
    ]);
  } finally {
    rmSync(situationPath(OWNER), { force: true });
    rmSync(situationPath(ANA), { force: true });
  }
});

const SAID_BY = / (by|heard as) jean/;

// audit-1-apple-open-loop: a plan he said aloud to no one (call the shop before buying the train) had no owner, so no
// one nudged him. `read_day` now lists it as due on its day; never someone else's to-do, a sender's or one already retired.
// Up to a week late it is still listed, labelled (a missed daily review), and what he waits on, on its day (#99).

test("audit-1-apple-open-loop: day lists the open to-dos and promises of the day or up to a week late, and waiting items on their day", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "life-due-")), "i.sqlite");
  const loop = (id: string, over: Partial<Observation>) =>
    ({
      about: "person:me",
      at: "2026-10-18T17:12:59.670Z",
      confidence: 0.9,
      date: "2026-10-18",
      entities: ["person:me"],
      id,
      importance: 3,
      quote: "tomorrow I'm going to call them",
      source: { channel: "lifelog", ref: "j:8@x" },
      speaker: "person:me",
      text: "Call the shop to ask for a morning pickup before booking the train.",
      type: "to_do",
      unit: "unit_000000000001",
      when: "2026-10-19",
      ...over,
    }) as unknown as Observation;
  const standing = {
    corrections: [],
    latest: new Map(),
    live: new Set(["unit_000000000001"]),
    retired: new Map([
      [
        "obs_000000000006",
        { by: "obs_000000000001", observation: "obs_000000000006" },
      ],
    ]),
  };
  buildIndex(
    [
      loop("obs_000000000001", {}),
      // His promise whose words a sender wrote: labelled "by", never left out (decision 11b).
      loop("obs_000000000002", {
        source: { channel: "whatsapp", ref: "m1" },
        speaker: "person:jean",
        type: "promise",
      }),
      loop("obs_000000000003", { speaker: "person:jean" }),
      loop("obs_000000000004", { speaker: "unknown:shop@mail.test" }),
      // His own to-do filed under a project is still his.
      loop("obs_000000000005", { about: "project:house" }),
      loop("obs_000000000006", {}),
      loop("obs_000000000007", { when: "2026-10-20" }),
      loop("obs_000000000008", { importance: 2 }),
      loop("obs_000000000009", { type: "news" }),
      // His promise whose quote opens with the other's request is still his to keep.
      loop("obs_000000000010", { speaker: "person:jean", type: "promise" }),
      // Late: 3 and 7 days overdue are listed (labelled), 8 days is not.
      loop("obs_000000000011", { when: "2026-10-16" }),
      loop("obs_000000000015", { when: "2026-10-12" }),
      loop("obs_000000000012", { when: "2026-10-11" }),
      // What he waits on from someone: on its day only.
      loop("obs_000000000013", {
        speaker: "person:jean",
        type: "waiting_on_someone",
      }),
      loop("obs_000000000014", {
        type: "waiting_on_someone",
        when: "2026-10-18",
      }),
      // Undated: the day after it was said (18 Oct), not two days after.
      loop("obs_000000000016", { when: undefined }),
      loop("obs_000000000017", { date: "2026-10-17", when: undefined }),
    ],
    path,
    standing as never
  );
  const lines = dueOf(new Database(path, { readonly: true }), "2026-10-19", {
    goals: [],
    levels: new Map(),
    more: [],
    shown: new Map(),
    today: "2026-10-19",
  });
  // Ranked: his promises first, then his to-dos, then what he waits on.
  expect(lines.map((l) => l.split(" ")[1])).toEqual([
    "obs_000000000002",
    "obs_000000000010",
    "obs_000000000001",
    "obs_000000000005",
    "obs_000000000011",
    "obs_000000000015",
    "obs_000000000016",
    "obs_000000000013",
  ]);
  expect(lines.filter((l) => l.endsWith(" (overdue)"))).toEqual(
    lines.slice(4, 6)
  );
  // Who spoke, when not him: "by" a sender, "heard as" a voice (lifelog misnames some).
  expect(lines.map((l) => l.match(SAID_BY)?.[0] ?? "")).toEqual([
    " by jean",
    " heard as jean",
    "",
    "",
    "",
    "",
    "",
    " heard as jean",
  ]);
  expect(dayLines({ due: lines })[0]).toStartWith("Due (open items");
});
