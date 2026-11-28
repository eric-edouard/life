import { afterAll, expect, test } from "bun:test";
import { withStore } from "./voice-server";
import {
  answerNamingQueue,
  namingQueueGuessesOf,
  readJobMonths,
  readNamingQueue,
  readNamingQueueNow,
  readVoiceNames,
} from "./voice-speakers";
import { voiceServer } from "./store-fixtures";

const DANA = "00000000-0000-4000-8000-000000000001";
const KOFI = "00000000-0000-4000-8000-000000000002";
const item = {
  clips: [],
  conversations: 2,
  evidence: [],
  id: "job-1:speaker_1",
  isLikely: false,
  kind: "known_person",
  likely: [DANA, KOFI],
  name: null,
  personId: DANA,
  voices: [],
  words: 400,
};
let queue: () => unknown = () => [item];
const server = voiceServer({
  "/naming-queue": () => queue(),
  "/naming-queue/answer": () => ({ ok: true }),
});
afterAll(() => server.close());

const ids = (q: { id: string }[]) => q.map((i) => i.id);
/** Lifelog's queue held open: each GET waits until `answerGet` gives it its list. */
const held: ((list: unknown) => void)[] = [];
const holdQueue = () => {
  queue = () => new Promise((r) => held.push(r));
};
/** Waits, a millisecond at a time, until `f` is true: no fixed sleep. */
const until = async (f: () => boolean | Promise<boolean>) => {
  // biome-ignore lint/performance/noAwaitInLoops: polls until the condition holds
  while (!(await f())) {
    await Bun.sleep(1);
  }
};
const answerGet = async (list: unknown) => {
  await until(() => held.length > 0);
  held.shift()?.(list);
};
const shows = async (id: string) => ids(await readNamingQueue()).join() === id;

test("the inbox's queue: the first read waits, then the last list comes at once with one read behind it; a failure keeps it and the next read retries", async () => {
  // One process for every test file: another may have kept a list first, so this server's shows on a later read.
  await until(() => shows("job-1:speaker_1"));
  holdQueue();
  // At once, twice: the kept list, with one read of lifelog behind it.
  expect(ids(await readNamingQueue())).toEqual(["job-1:speaker_1"]);
  expect(ids(await readNamingQueue())).toEqual(["job-1:speaker_1"]);
  await until(() => held.length > 0);
  expect(held.length).toBe(1);
  await answerGet([{ ...item, id: "job-2:speaker_1" }]);
  queue = () => [{ ...item, id: "job-2:speaker_1" }];
  await until(() => shows("job-2:speaker_1"));
  // Failed reads keep the list, and the next read tries again.
  let failed = 0;
  queue = () => {
    failed += 1;
    return [{ id: 1 }];
  };
  await until(async () => (await shows("job-2:speaker_1")) && failed >= 2);
  queue = () => [{ ...item, id: "job-4:A" }];
  await until(() => shows("job-4:A"));
  queue = () => [{ id: 1 }];
  await expect(readNamingQueueNow()).rejects.toThrow();
});

test("an answered voice leaves the kept list; a read started before the answer does not bring it back", async () => {
  const voice = { conversationId: "c1", jobId: "job-3", speakerLabel: "A" };
  const listed = [{ ...item, id: "job-3:A", voices: [voice] }];
  queue = () => listed;
  await until(() => shows("job-3:A"));
  holdQueue();
  expect(ids(await readNamingQueue())).toEqual(["job-3:A"]);
  await until(() => held.length === 1);
  await answerNamingQueue([voice], { kind: "ignore" });
  await answerGet(listed);
  // Every read until the display's old read has settled (a new one starts) shows the answered voice gone.
  const seen: string[][] = [];
  await until(async () => {
    seen.push(ids(await readNamingQueue()));
    return held.length > 0;
  });
  expect(seen.flat()).toEqual([]);
  await answerGet([]);
});

test("a voice's guesses: its best guess first, each once", () => {
  expect(
    namingQueueGuessesOf({ ...item, likely: [KOFI, DANA, KOFI] } as never)
  ).toEqual([DANA, KOFI]);
});

test("a job's months run from its first conversation's start to its last turn; a job not held has none", async () => {
  await withStore(({ db }) => {
    for (const [id, start] of [
      ["c-months-2", "2026-09-01T00:10:00.000Z"],
      ["c-months", "2026-07-31T23:00:00.000Z"],
    ] as const) {
      db.run(
        "insert or replace into conversations (id, start_at, end_at, kind, state) values (?, ?, ?, 'speech', 'live')",
        [id, start, start]
      );
    }
    // The job's last turn sits in the later conversation: its months still start at the first one.
    for (const [i, conversation, at] of [
      [0, "c-months", "2026-07-31T23:30:00.000Z"],
      [1, "c-months-2", "2026-09-01T00:30:00.000Z"],
    ] as const) {
      db.run(
        "insert or replace into turns (job_id, turn_index, conversation_id, start_at) values ('j-months', ?, ?, ?)",
        [i, conversation, at]
      );
    }
  });
  expect(await readJobMonths(["j-months", "j-none"])).toEqual([
    "2026-07",
    "2026-08",
    "2026-09",
  ]);
});

test("the name lifelog gave a person id is its newest turn's, found by id or by any name it gave", async () => {
  await withStore(({ db }) => {
    for (const [i, at, id, name] of [
      [0, "2026-10-02T00:00:00.000Z", "p-names-1", "Dana"],
      [1, "2026-10-01T00:00:00.000Z", "p-names-1", "Dani"],
      [2, "2026-10-03T00:00:00.000Z", "p-names-1", null],
      [3, "2026-10-01T00:00:00.000Z", "p-names-2", null],
    ] as const) {
      db.run(
        "insert or replace into turns (job_id, turn_index, conversation_id, start_at, person_id, person_name) values ('j-names', ?, 'c-months', ?, ?, ?)",
        [i, at, id, name]
      );
    }
  });
  // By id, and by a name it gave (any case): an id with no named turn has none.
  expect(await readVoiceNames(["p-names-1", "p-names-2"])).toEqual({
    "p-names-1": "Dana",
  });
  expect(await readVoiceNames([], ["dani"])).toEqual({ "p-names-1": "Dana" });
  expect(await readVoiceNames([])).toEqual({});
});
