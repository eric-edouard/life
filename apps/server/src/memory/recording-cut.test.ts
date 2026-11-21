import { afterAll, expect, test } from "bun:test";
import { apply } from "../sources/lifelog";
import {
  conversation,
  lifelogServer,
  lifelogStore,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { openById } from "./open-by-id";
import { WITHIN_REFUSED, wordsWithin } from "./recording-cut";
import { fetchOf } from "./words";

// A recording read cut to a call's exact span (life#875): nothing said before or after the call comes back.
// Made-up call and recording: 10:00:00 to 10:10:00, each turn its start, end, words and their timings (none: no clip).

const CALL = {
  at: "2026-10-14T10:00:00.000Z",
  until: "2026-10-14T10:10:00.000Z",
};
const TURNS: [string, string, string, number[][]?][] = [
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
];

const server = lifelogServer({
  "/transcription-jobs/job-call/transcript": () => ({
    turns: TURNS.map(([, , text]) => ({ speakerId: null, text })),
  }),
  // A turn's clip, its words' timings in ms from its start; the untimed turn gives none.
  "/turns/clip": (_, q) => {
    const [at, , text, words] = TURNS[Number(q.get("turnIndex"))] ?? [];
    return words ? { at, audio: null, text, until: null, words } : null;
  },
});
afterAll(() => server.close());

const open = () => {
  const store = lifelogStore();
  apply(
    store,
    pageFixture({
      conversations: [conversation("c-call")],
      turns: TURNS.map(([startAt, endAt], n) => ({
        ...turnFixture(n, startAt, null, null, "c-call"),
        endAt,
        jobId: "job-call",
      })),
    })
  );
  return store;
};

test("cut to a call: 30 s before and after left out, inside kept, a crossing turn kept to its timed words inside", async () => {
  const read = await fetchOf("c-call", undefined, 200, open, CALL);
  expect(read).toContain(`cut to ${CALL.at} until ${CALL.until}: 1–4 of 4`);
  expect(read).toContain("Call middle");
  expect(read).not.toContain("Room before");
  expect(read).not.toContain("Room after");
  expect(read).toContain("unknown:speaker: hello");
  expect(read).not.toContain("Ringing");
  expect(read).toContain("unknown:speaker: Goodbye");
  expect(read).not.toContain("room after");
  // A crossing turn lifelog gives no timings for says nothing.
  expect(read).not.toContain("Untimed");
});

test("cut to a call: a turn ref opens at the span's first turn, and a page on keeps the span", async () => {
  const first = await fetchOf(
    "job-call:2@2026-10-14T10:05:00.000Z",
    undefined,
    1,
    open,
    CALL
  );
  expect(first).toContain("1–1 of 4");
  expect(first).toContain("hello");
  expect(first).toContain(
    `(more: fetch c-call --at ${CALL.at} --until ${CALL.until} --from-turn 1)`
  );
  expect(await fetchOf("c-call", 1, 1, open, CALL)).toContain("Call middle");
});

test("only a recording takes a span", async () => {
  expect(
    await openById(
      "msg:whatsapp|x",
      undefined,
      undefined,
      async () => "",
      undefined,
      CALL
    )
  ).toContain(WITHIN_REFUSED);
});

test("a clip's words wholly inside a span, as spelled; none without timings", () => {
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
  expect(wordsWithin({ ...timed, at: null }, span)).toBe("");
  expect(wordsWithin(null, span)).toBe("");
});
