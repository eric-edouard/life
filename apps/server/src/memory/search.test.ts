import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeJson } from "../core/files";
import { promptNameOf } from "../models/prompt-parts";
import type { Observation } from "../records/observation";
import type { ReadReply } from "../records/read-reply";
import { SUMMARY_READ } from "../records/read-reply";
import type { Unit } from "../records/unit";
import { apply, openStore } from "../sources/lifelog";
import { readSpokenTurns } from "../sources/lifelog-conversations";
import {
  conversation,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { currentSummaries } from "./conversation-summaries";
import { buildIndex, reindexUnits } from "./index-writer";
import { INDEX, readReplyPath, situationPath } from "./memory-files";
import { heldLines } from "./read-person-page";
import { READS, storeReply } from "./read-replies";
import { OWNER } from "./read-truth";
import { madeBy } from "./record-fixtures";
import { readSituationsOf, search, matches as searchMatches } from "./search";
import { turnKey } from "./units";

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
      madeBy: {
        engine: "claude",
        model: "m",
        prompt: promptNameOf("memory-situation.v3"),
        run: "r",
      },
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
  const header =
    "(where things stand, read each night from the 30 days up to their newest episode):";
  try {
    await expect(
      readSituationsOf("what bothers me lately", live, new Set([ep]), true)
    ).resolves.toEqual([
      `Test's situation ${header}`,
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
      `Test's situation, on the episodes below ${header}`,
      `- He argues with his father about the house. [${ep}]`,
      "",
    ]);
  } finally {
    rmSync(situationPath(OWNER), { force: true });
    rmSync(situationPath(ANA), { force: true });
  }
});

test("search: a conversation summary is found by a word of it and listed with the ref that opens it", async () => {
  const at = "2026-10-14T10:00:00.000Z";
  const store = openStore();
  apply(
    store,
    pageFixture({
      conversations: [conversation("c-search")],
      turns: [
        {
          ...turnFixture(0, at, null, null, "c-search", true),
          jobId: "job-search",
        },
        {
          ...turnFixture(1, at, "p1", "Dana", "c-search"),
          jobId: "job-search",
        },
      ],
    })
  );
  const keys = readSpokenTurns(store, new Map())
    .filter((t) => t.jobId === "job-search")
    .map(turnKey);
  store.db.close();
  const line = {
    at,
    madeBy: { ...madeBy, prompt: READS.conversation_summary.prompt },
    messages: keys,
    promptDigest: "0123456789abcdef",
    read: SUMMARY_READ,
    reply: {
      subjects: [{ label: "Gutter repair", line: 1 }],
      summary: "They priced the gutter repair.",
    },
    schemaVersion: 1,
    starts: [0],
  } as ReadReply;
  storeReply(line, at);
  try {
    mkdirSync(dirname(INDEX), { recursive: true });
    const [held] = await currentSummaries();
    expect(held?.ref).toBe(`job-search:0@${at}`);
    buildIndex(
      [],
      INDEX,
      {
        corrections: [],
        latest: new Map(),
        live: new Set(),
        retired: new Map(),
      },
      [],
      new Date("2099-01-01"),
      [],
      held ? [held] : []
    );
    const found = await search("gutter");
    expect(found).toContain("Conversation summaries (");
    expect(found).toContain(
      "Gutter repair: They priced the gutter repair. (`fetch person:me/conversation/job-search:0@" +
        at +
        "`)"
    );
  } finally {
    rmSync(readReplyPath(at), { force: true });
    rmSync(INDEX, { force: true });
    const cleanup = openStore();
    cleanup.db.run("delete from turns where job_id = 'job-search'");
    cleanup.db.close();
  }
});
