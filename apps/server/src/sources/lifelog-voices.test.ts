import { afterAll, expect, test } from "bun:test";
import { namingQueueGuessesOf, readNamingQueue } from "./lifelog-voices";
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
const server = lifelogServer({ "/naming-queue": () => queue() });
afterAll(() => server.close());

test("the naming queue is read; while lifelog fails it the last list stands, never failing", async () => {
  expect((await readNamingQueue()).map((i) => i.id)).toEqual([
    "job-1:speaker_1",
  ]);
  queue = () => [{ id: 1 }];
  expect((await readNamingQueue()).map((i) => i.id)).toEqual([
    "job-1:speaker_1",
  ]);
  queue = () => [];
  expect(await readNamingQueue()).toEqual([]);
});

test("a voice's guesses: its best guess first, each once", () => {
  expect(
    namingQueueGuessesOf({ ...item, likely: [KOFI, DANA, KOFI] } as never)
  ).toEqual([DANA, KOFI]);
});
