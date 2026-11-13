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
import { matterBookOf } from "./matter-read";
import { situationPath } from "./memory-files";
import { openItems } from "./open-items";
import { dayLines } from "./read-day";
import { matterItems } from "./read-open-items";
import { heldLines } from "./read-person-page";
import { OWNER } from "./read-truth";
import { readSituationsOf, matches as searchMatches } from "./search";

test("search: an observation hit names the unit it comes from and who is in it", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "life-search-")), "i.sqlite");
  const o = {
    at: "2026-10-14T10:01:00.000Z",
    date: "2026-10-14",
    id: "obs_1",
    importance: 2,
    quote: "il est à rework",
    source: { channel: "lifelog", ref: "j:0@x" },
    subjects: ["project:photo-app"],
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
  const statusInputs = {
    corrections: [],
    latest: new Map(),
    live: new Set([unit.id]),
    retired: new Map(),
  };
  buildIndex([o], path, statusInputs, [{ unit }]);
  const db = new Database(path, { readonly: true });
  const [hit] = searchMatches(db, "beautify");
  expect(hit).toEndWith(
    '(lifelog "Improving output prompts before advertising tests"; jerome, Bob)'
  );
  // A handle held across a rebuild reads the new index (one held across a file swap failed).
  buildIndex(
    [{ ...o, text: "Jean will polish the prompt." }],
    path,
    statusInputs
  );
  expect(searchMatches(db, "beautify")).toEqual(["(nothing found)"]);
  expect(searchMatches(db, "polish")[0]).toContain("polish the prompt");
  // A table no schema has any more goes at the next rebuild.
  const writer = new Database(path);
  writer.run("create table stale (x)");
  writer.close();
  buildIndex([o], path, statusInputs, [{ unit }]);
  expect(
    db.query("select name from sqlite_schema where name = 'stale'").get()
  ).toBeNull();
  // A rebuild that fails leaves the last index whole.
  expect(() =>
    buildIndex(
      [{ ...o, source: undefined } as unknown as Observation],
      path,
      statusInputs
    )
  ).toThrow();
  expect(searchMatches(db, "beautify")[0]).toBe(hit);
  // A unit's people are kept once each: the index takes them as reindex maps them today (two refs may fold into one).
  buildIndex([o], path, statusInputs, [
    { unit: { ...unit, people: ["person:jerome", "person:jerome"] } },
  ]);
  expect(
    db.query("select person from unit_people where unit = ?").all(unit.id)
  ).toEqual([{ person: "person:jerome" }]);
  buildIndex([o], path, statusInputs, [{ unit }]);
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

// audit-1-apple-open-loop: a plan he said aloud to no one (call the shop before buying the train) had no owner, so no
// one nudged him. `read_day` lists it as due on its day, as a matter of one; never someone else's to-do, a sender's or
// one already ended. Up to a week late it is still listed, labelled (a missed daily review), and what he waits on, on
// its day (#99).

test("audit-1-apple-open-loop: day lists the open to-dos and promises of the day or up to a week late, and waiting items on their day", () => {
  const loop = (n: number, over: Partial<Observation>) =>
    ({
      area: null,
      at: "2026-10-18T17:12:59.670Z",
      date: "2026-10-18",
      id: `obs_${String(n).padStart(12, "0")}`,
      importance: 3,
      quote: "tomorrow I'm going to call them",
      speaker: OWNER,
      subjects: [OWNER],
      text: "Call the shop to ask for a morning pickup before booking the train.",
      type: "to_do",
      unit: "unit_000000000001",
      when: "2026-10-19",
      ...over,
    }) as unknown as Observation;
  const JEAN = "person:jean";
  const observations = [
    loop(1, {}),
    // His promise to Jean, whose words a sender wrote: owed to him by name, never left out (decision 11b).
    loop(2, { speaker: JEAN, subjects: [OWNER, JEAN], type: "promise" }),
    // Someone else's to-do, a sender's: not his.
    loop(3, { speaker: JEAN }),
    loop(4, { speaker: "unknown:shop@mail.test" }),
    // His own to-do filed under a project is still his.
    loop(5, { subjects: [OWNER, "project:house"] }),
    // Ended: a later observation shows it done.
    loop(6, {}),
    loop(7, { when: "2026-10-20" }),
    loop(8, { importance: 2 }),
    loop(9, { type: "news" }),
    loop(10, { speaker: JEAN, subjects: [OWNER, JEAN], type: "promise" }),
    // Late: 3 and 7 days overdue are listed (labelled), 8 days is not.
    loop(11, { when: "2026-10-16" }),
    loop(15, { when: "2026-10-12" }),
    loop(12, { when: "2026-10-11" }),
    // What he waits on from someone: on its day only.
    loop(13, { subjects: [OWNER, JEAN], type: "waiting_on_someone" }),
    loop(14, { type: "waiting_on_someone", when: "2026-10-18" }),
    // Undated: the day after it was said (18 Oct), not two days after.
    loop(16, { when: null }),
    loop(17, { date: "2026-10-17", when: null }),
  ];
  const book = matterBookOf(
    [],
    {
      endings: new Map([["obs_000000000006", {}]]),
      episodeOf: new Map(),
      ledger: [],
      observations,
      refOf: (r) => r,
      todoItems: [],
    },
    "2026-10-19"
  );
  const lines = openItems(
    matterItems(book, (r) => r.replace("person:", "")),
    {
      date: "2026-10-19",
      goals: [],
      levels: new Map(),
      shown: new Map(),
      today: "2026-10-19",
    }
  );
  // Ranked: his promises first, then his to-dos, then what he waits on.
  expect(lines.map((l) => l.id.slice(-2))).toEqual([
    "02",
    "10",
    "01",
    "05",
    "11",
    "15",
    "16",
    "13",
  ]);
  expect(lines.filter((l) => l.overdue).map((l) => l.id.slice(-2))).toEqual([
    "11",
    "15",
  ]);
  // Who it is owed to, when not him, is named.
  expect(lines[0]?.line).toContain("owed to jean");
  expect(dayLines({ due: lines.map((l) => l.line) })[0]).toStartWith(
    "Due (open items"
  );
});
