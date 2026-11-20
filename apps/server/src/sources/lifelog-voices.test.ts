import { afterAll, expect, test } from "bun:test";
import {
  answerNamingQueue,
  namingQueueGuessesOf,
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
const settle = () => Bun.sleep(20);

test("the inbox's queue: the first read waits, then the last list comes at once with a read behind it; a failure keeps it", async () => {
  expect(ids(await readNamingQueue())).toEqual(["job-1:speaker_1"]);
  queue = () => [{ ...item, id: "job-2:speaker_1" }];
  // At once: the kept list, while lifelog is read again behind it.
  expect(ids(await readNamingQueue())).toEqual(["job-1:speaker_1"]);
  await settle();
  expect(ids(await readNamingQueue())).toEqual(["job-2:speaker_1"]);
  queue = () => [{ id: 1 }];
  await readNamingQueue();
  await settle();
  expect(ids(await readNamingQueue())).toEqual(["job-2:speaker_1"]);
  await expect(readNamingQueueNow()).rejects.toThrow();
});

test("an answered voice leaves the kept list, and a read that started before the answer cannot bring it back", async () => {
  const voice = { conversationId: "c1", jobId: "job-3", speakerLabel: "A" };
  queue = () => [{ ...item, id: "job-3:A", voices: [voice] }];
  expect(ids(await readNamingQueueNow())).toEqual(["job-3:A"]);
  let release: () => void = () => undefined;
  queue = () =>
    new Promise((r) => {
      release = () => r([{ ...item, id: "job-3:A", voices: [voice] }]);
    });
  const before = readNamingQueueNow();
  await settle();
  await answerNamingQueue([voice], { kind: "ignore" });
  release();
  await before;
  queue = () => [];
  expect(ids(await readNamingQueue())).toEqual([]);
});

test("a voice's guesses: its best guess first, each once", () => {
  expect(
    namingQueueGuessesOf({ ...item, likely: [KOFI, DANA, KOFI] } as never)
  ).toEqual([DANA, KOFI]);
});
