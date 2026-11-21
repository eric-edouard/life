import { afterAll, expect, test } from "bun:test";
import { withStore } from "./lifelog";
import {
  answerNamingQueue,
  namingQueueGuessesOf,
  readJobMonths,
  readNamingQueue,
  readNamingQueueNow,
} from "./lifelog-voices";
import { lifelogServer } from "./store-fixtures";

const DANA = "00000000-0000-4000-8000-000000000001";
const KOFI = "00000000-0000-4000-8000-000000000002";
const item = {
  clips: [],
  conversations: 2,
  evidence: [],
  id: "job-1:speaker_1",
  kind: "known_person",
  likely: [DANA, KOFI],
  name: null,
  personId: DANA,
  voices: [],
  words: 400,
};
let queue: () => unknown = () => [item];
const server = lifelogServer({
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

test("a job's months run from its conversation's start to its last turn; a job not held has none", async () => {
  await withStore(({ db }) => {
    db.run(
      "insert or replace into conversations (id, start_at, end_at, kind, state) values ('c-months', '2026-08-31T23:00:00.000Z', '2026-09-01T01:00:00.000Z', 'speech', 'live')"
    );
    for (const [i, at] of [
      "2026-08-31T23:30:00.000Z",
      "2026-09-01T00:30:00.000Z",
    ].entries()) {
      db.run(
        "insert or replace into turns (job_id, turn_index, conversation_id, start_at) values ('j-months', ?, 'c-months', ?)",
        [i, at]
      );
    }
  });
  expect(await readJobMonths(["j-months", "j-none"])).toEqual([
    "2026-08",
    "2026-09",
  ]);
});
