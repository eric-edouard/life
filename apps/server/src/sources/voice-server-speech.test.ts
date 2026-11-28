import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, openStore, Page, storeFiles } from "./voice-server";
import { recordingsOf } from "./voice-server-speech";
import {
  conversation,
  pageFixture,
  voiceStore as store,
  turnFixture,
} from "./store-fixtures";

const FROM = "2026-10-14T10:00:00.000Z";
const TO = "2026-10-14T10:10:00.000Z";

const job = (
  id: string,
  firstPage: number,
  over: Record<string, unknown> = {}
) => ({
  id,
  pages: [[firstPage, firstPage + 1]],
  sourceId: "phone-1",
  state: "completed",
  ...over,
});

const turn = (
  jobId: string,
  index: number,
  at: string,
  conv = "c1",
  endAt = at
) => ({ ...turnFixture(index, at, null, null, conv), endAt, jobId });

const put = (s: ReturnType<typeof store>, over: Record<string, unknown>) =>
  apply(s, Page.parse(pageFixture(over)));

test("no turn inside the call gives nothing", () => {
  const s = store();
  put(s, {
    conversations: [conversation("c1")],
    jobs: [job("j1", 1)],
    turns: [turn("j1", 0, "2026-10-14T09:00:00.000Z")],
  });
  expect(recordingsOf(s, FROM, TO)).toBeNull();
});

test("a turn crossing the call's opening is the call's, as fetch cut to the call reads it; one ended before is not", () => {
  const s = store();
  put(s, {
    conversations: [conversation("c1"), conversation("c2")],
    jobs: [job("j1", 1), job("j2", 5)],
    turns: [
      turn(
        "j1",
        0,
        "2026-10-14T09:59:30.000Z",
        "c1",
        "2026-10-14T09:59:40.000Z"
      ),
      turn(
        "j1",
        1,
        "2026-10-14T09:59:50.000Z",
        "c1",
        "2026-10-14T10:00:20.000Z"
      ),
      turn("j2", 0, "2026-10-14T10:20:00.000Z", "c2"),
    ],
  });
  expect(recordingsOf(s, FROM, TO)).toEqual([
    { turn: "j1:1@2026-10-14T09:59:50.000Z", turns: 1 },
  ]);
});

test("a later turn of the same phone makes the words in, unless an earlier recording is still to come", () => {
  const s = store();
  put(s, {
    conversations: [conversation("c1"), conversation("c2")],
    jobs: [job("j1", 1), job("j0", 0, { state: "submitted" }), job("j2", 5)],
    turns: [
      turn("j1", 0, "2026-10-14T10:02:00.000Z"),
      turn("j1", 1, "2026-10-14T10:03:00.000Z"),
      turn("j2", 0, "2026-10-14T10:20:00.000Z", "c2"),
    ],
  });
  expect(recordingsOf(s, FROM, TO)).toBeNull();
  put(s, { jobs: [job("j0", 0)] });
  expect(recordingsOf(s, FROM, TO)).toEqual([
    { turn: "j1:0@2026-10-14T10:02:00.000Z", turns: 2 },
  ]);
});

test("a recording that ended on silence within lifelog's span of the call's end is in; one that ended mid-call is not", () => {
  const s = store();
  put(s, {
    conversations: [conversation("c1", { endAt: TO })],
    jobs: [job("j1", 1, { endedOnSilence: true })],
    turns: [turn("j1", 0, "2026-10-14T10:09:50.000Z")],
  });
  expect(recordingsOf(s, FROM, TO)?.length).toBe(1);
  const mid = store();
  put(mid, {
    conversations: [conversation("c1")],
    jobs: [job("j1", 1, { endedOnSilence: true })],
    turns: [turn("j1", 0, "2026-10-14T10:03:00.000Z")],
  });
  expect(recordingsOf(mid, FROM, TO)).toBeNull();
});

test("a closed conversation counts only when its end reaches the call's end", () => {
  const reaches = store();
  put(reaches, {
    conversations: [conversation("c1", { closed: true, endAt: TO })],
    jobs: [job("j1", 1)],
    turns: [turn("j1", 0, "2026-10-14T10:05:00.000Z")],
  });
  expect(recordingsOf(reaches, FROM, TO)?.length).toBe(1);
  const before = store();
  put(before, {
    conversations: [
      conversation("c1", { closed: true, endAt: "2026-10-14T10:03:00.000Z" }),
    ],
    jobs: [job("j1", 1)],
    turns: [turn("j1", 0, "2026-10-14T10:02:00.000Z")],
  });
  expect(recordingsOf(before, FROM, TO)).toBeNull();
});

test("a withdrawn recording inside the call keeps the words pending until a recording holds its page again", () => {
  const s = store();
  put(s, {
    conversations: [conversation("c1", { closed: true, endAt: TO })],
    jobs: [job("j1", 1), job("j2", 5)],
    removed: [{ firstPage: 3, kind: "job", ref: "j0", sourceId: "phone-1" }],
    turns: [
      turn("j1", 0, "2026-10-14T10:02:00.000Z"),
      turn("j2", 0, "2026-10-14T10:05:00.000Z"),
    ],
  });
  expect(recordingsOf(s, FROM, TO)).toBeNull();
  // lifelog joins the re-sent pages into a recording that starts at another page.
  put(s, { jobs: [{ ...job("j0b", 2), pages: [[2, 4]] }] });
  expect(recordingsOf(s, FROM, TO)).toEqual([
    { turn: "j1:0@2026-10-14T10:02:00.000Z", turns: 2 },
  ]);
});

test("a withdrawn recording that held the call's opening keeps it pending until a recording holds its page again", () => {
  const s = store();
  put(s, {
    conversations: [conversation("c1", { closed: true, endAt: TO })],
    jobs: [job("j8", 1), job("j1", 6)],
    removed: [{ firstPage: 4, kind: "job", ref: "j0", sourceId: "phone-1" }],
    turns: [
      turn("j8", 0, "2026-10-14T09:00:00.000Z"),
      turn("j1", 0, "2026-10-14T10:05:00.000Z"),
    ],
  });
  expect(recordingsOf(s, FROM, TO)).toBeNull();
  put(s, { jobs: [{ ...job("j0b", 3), pages: [[3, 5]] }] });
  expect(recordingsOf(s, FROM, TO)).toEqual([
    { turn: "j1:0@2026-10-14T10:05:00.000Z", turns: 1 },
  ]);
});

test("a hole long before the call never holds it back: a withdrawn page sent again or not, a recording stuck queued", () => {
  const [from, to] = ["2026-10-15T10:00:00.000Z", "2026-10-15T10:10:00.000Z"];
  const withdrawn = {
    removed: [{ firstPage: 2, kind: "job", ref: "j0", sourceId: "phone-1" }],
  };
  for (const hole of [
    { ...withdrawn, jobs: [{ ...job("j0b", 1), pages: [[1, 3]] }] },
    { ...withdrawn, jobs: [] },
    { jobs: [job("j0", 2, { state: "queued" })] },
  ]) {
    const s = store();
    put(s, {
      ...hole,
      conversations: [conversation("c2", { closed: true, endAt: to })],
      jobs: [...hole.jobs, job("j8", 30), job("j9", 40)],
      turns: [
        turn("j8", 0, "2026-10-15T08:00:00.000Z", "c2"),
        turn("j9", 0, "2026-10-15T10:05:00.000Z", "c2"),
      ],
    });
    expect(recordingsOf(s, from, to)).toEqual([
      { turn: "j9:0@2026-10-15T10:05:00.000Z", turns: 1 },
    ]);
  }
});

test("one entry per conversation, each with its first turn and its count", () => {
  const s = store();
  put(s, {
    conversations: [
      conversation("c1", { closed: true, endAt: TO }),
      conversation("c2", { closed: true, endAt: TO }),
    ],
    jobs: [job("j1", 1)],
    turns: [
      turn("j1", 0, "2026-10-14T10:01:00.000Z"),
      turn("j1", 1, "2026-10-14T10:02:00.000Z", "c2"),
      turn("j1", 2, "2026-10-14T10:03:00.000Z", "c2"),
    ],
  });
  expect(recordingsOf(s, FROM, TO)).toEqual([
    { turn: "j1:0@2026-10-14T10:01:00.000Z", turns: 1 },
    { turn: "j1:1@2026-10-14T10:02:00.000Z", turns: 2 },
  ]);
});

test("a store made before the recordings' state and pages gains the columns and fills them", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-lifelog-"));
  try {
    const old = new Database(storeFiles(dir).file);
    old.run(`create table conversations (
      id text primary key, start_at text not null, end_at text not null, kind text not null, state text not null,
      title text not null, successor text, closed integer);
    create table transcription_jobs (id text primary key, ended_on_silence integer);`);
    old.close();
    const upgraded = openStore(dir);
    put(upgraded, { jobs: [job("j1", 3)] });
    expect(
      upgraded.db
        .query(
          "select state, source_id, first_page, last_page from transcription_jobs"
        )
        .get()
    ).toEqual({
      first_page: 3,
      last_page: 4,
      source_id: "phone-1",
      state: "completed",
    });
    upgraded.db.close();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
