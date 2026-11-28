import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import {
  conversation,
  pageFixture,
  turnFixture,
  voiceServer,
  voiceStore,
} from "../sources/store-fixtures";
import { apply, openStore } from "../sources/voice-server";
import { cutOf } from "./deletions";
import { CORRECTIONS } from "./memory-files";
import { openById } from "./open-by-id";
import {
  clippedOf,
  GOES_ON,
  NOT_TIMED,
  WITHIN_REFUSED,
  wordsWithin,
} from "./recording-cut";
import { fetchOf } from "./words";

// A recording read cut to a call's exact span (life#875): nothing said before or after the call comes back.
// Made-up call and recording: 10:00:00 to 10:10:00, each turn its start, end, words and their timings (none: no clip).

const CALL = {
  at: "2026-10-14T10:00:00.000Z",
  until: "2026-10-14T10:10:00.000Z",
};
const TURNS: [string, string, string, number[][]?, string?][] = [
  ["2026-10-14T09:59:30.000Z", "2026-10-14T09:59:40.000Z", "Room before"],
  [
    "2026-10-14T09:59:50.000Z",
    "2026-10-14T10:00:20.000Z",
    "Ringing hello",
    [
      [0, 5000, 7],
      [15_000, 25_000, 6],
    ],
  ],
  ["2026-10-14T10:05:00.000Z", "2026-10-14T10:05:10.000Z", "Call middle"],
  [
    "2026-10-14T10:09:50.000Z",
    "2026-10-14T10:10:20.000Z",
    "Goodbye room after",
    [
      [0, 5000, 7],
      [21_000, 25_000, 5],
      [26_000, 30_000, 6],
    ],
  ],
  ["2026-10-14T10:09:58.000Z", "2026-10-14T10:10:05.000Z", "Untimed edge"],
  ["2026-10-14T10:10:30.000Z", "2026-10-14T10:10:40.000Z", "Room after"],
  // A legacy turn with no end stored: one word before hang-up, one after.
  [
    "2026-10-14T10:09:59.000Z",
    "",
    "Bye secret",
    [
      [0, 500, 3],
      [2000, 3000, 7],
    ],
  ],
  // A long turn into the call whose timings stop at its preview's end, before the call: none of it is read.
  [
    "2026-10-14T09:59:00.000Z",
    "2026-10-14T10:01:00.000Z",
    "Long room talk",
    [[0, 4000, 4]],
    "2026-10-14T09:59:20.000Z",
  ],
];

const server = voiceServer({
  "/transcription-jobs/job-call/transcript": () => ({
    turns: TURNS.map(([, , text]) => ({ speakerId: null, text })),
  }),
  // A turn's clip, its words' timings in ms from its start; the untimed turn gives none.
  "/turns/clip": (_, q) => {
    const [at, , text, words, until] = TURNS[Number(q.get("turnIndex"))] ?? [];
    return words
      ? { at, audio: null, text, until: until ?? null, words }
      : null;
  },
});
afterAll(() => server.close());

const open = () => {
  const store = voiceStore();
  apply(
    store,
    pageFixture({
      conversations: [conversation("c-call")],
      turns: TURNS.map(([startAt, endAt], n) => ({
        ...turnFixture(n, startAt, null, null, "c-call"),
        endAt: endAt || startAt,
        jobId: "job-call",
      })),
    })
  );
  store.db.run("update turns set end_at = null where turn_index = 6");
  return store;
};

test("cut to a call: 30 s before and after left out, inside kept, a crossing turn kept to its timed words inside", async () => {
  const read = await fetchOf("c-call", undefined, 200, open, CALL);
  expect(read).toContain(`cut to ${CALL.at} until ${CALL.until}: 1–6 of 6`);
  expect(read).toContain("Call middle");
  expect(read).not.toContain("Room before");
  expect(read).not.toContain("Room after");
  expect(read).toContain("unknown:speaker: hello");
  expect(read).not.toContain("Ringing");
  expect(read).toContain("unknown:speaker: Goodbye");
  expect(read).not.toContain("room after");
  // A turn with no end stored is clipped too: its word after hang-up is not read.
  expect(read).toContain("unknown:speaker: Bye");
  expect(read).not.toContain("secret");
  // A crossing turn with no timings is said to be left out; one whose timings stop early is said to go on unread.
  expect(read).not.toContain("Untimed");
  expect(read).toContain(NOT_TIMED);
  expect(read).not.toContain("Long");
  expect(read).toContain(GOES_ON);
});

test("a crossing turn whose clip holds no word timings is said to be left out", () => {
  const turn = {
    at: "2026-10-14T10:09:50.000Z",
    end: "2026-10-14T10:10:20.000Z",
  } as Parameters<typeof clippedOf>[0];
  expect(
    clippedOf(turn, { at: turn.at, text: "", until: null, words: [] }, CALL)
  ).toBe(NOT_TIMED);
});

test("cut to a call: a turn ref opens at the span's first turn, and a page on keeps the span", async () => {
  const first = await fetchOf(
    "job-call:2@2026-10-14T10:05:00.000Z",
    undefined,
    1,
    open,
    CALL
  );
  expect(first).toContain("1–1 of 6");
  expect(first).toContain(GOES_ON);
  expect(first).toContain(
    `(more: fetch c-call --at ${CALL.at} --until ${CALL.until} --from-turn 1)`
  );
  // Page two through fetch's entry, from Life's own store.
  apply(
    openStore(),
    pageFixture({
      conversations: [conversation("c-call-live")],
      turns: TURNS.map(([startAt, endAt], n) => ({
        ...turnFixture(n, startAt, null, null, "c-call-live"),
        endAt: endAt || startAt,
        jobId: "job-call",
      })),
    })
  );
  const second = await openById(
    "c-call-live",
    1,
    1,
    async () => "",
    undefined,
    CALL
  );
  expect(second).toContain("2–2 of 6");
  expect(second).toContain("hello");
});

test("only a recording takes a span", async () => {
  const refused = await Promise.all(
    ["msg:whatsapp|x", "person:test-ana/now"].map((id) =>
      openById(id, undefined, undefined, async () => "", undefined, CALL)
    )
  );
  for (const r of refused) {
    expect(r).toContain(WITHIN_REFUSED);
  }
  expect(await fetchOf("claude:abc", undefined, 200, open, CALL)).toContain(
    WITHIN_REFUSED
  );
});

test("a clip's words wholly inside a span, as spelled; an open side holds all; none without timings", () => {
  const timed = {
    at: CALL.at,
    text: "one two three",
    words: [
      [0, 1000, 3],
      [59_000, 61_000, 4],
      [61_000, 62_000, 6],
    ],
  };
  const span = { at: CALL.at, until: "2026-10-14T10:01:00.000Z" };
  expect(wordsWithin(timed, span)).toBe("one");
  expect(wordsWithin(timed, { until: span.until })).toBe("one");
  expect(wordsWithin(timed, { at: "2026-10-14T10:00:59.000Z" })).toBe(
    "two three"
  );
  expect(wordsWithin({ ...timed, at: null }, span)).toBe("");
  expect(wordsWithin(null, span)).toBe("");
});

test("a crossing turn he cut words in is shown with no words at all: its clip holds them at places of its own", async () => {
  const turn = "job-call:1";
  const correction = {
    at: "2026-11-24T09:00:00.000Z",
    cuts: [cutOf(turn, "Ringing hello", 8, 13)],
    kind: "deleted",
    refs: [],
    said: "that goes",
    schemaVersion: 1,
    withSources: false,
  };
  try {
    writeFileSync(CORRECTIONS, `${JSON.stringify(correction)}\n`, {
      flag: "a",
    });
    const read = await fetchOf("c-call", undefined, 200, open, CALL);
    // Its timed words inside the span ("hello") are the clip's, cut at places of the turn's own: the turn shows none.
    expect(read).not.toContain("hello");
    expect(read).not.toContain("Ringing");
    // The turns wholly inside the call are read as they were.
    expect(read).toContain("Call middle");
    expect(read).toContain("Goodbye");
  } finally {
    rmSync(CORRECTIONS, { force: true });
  }
});
