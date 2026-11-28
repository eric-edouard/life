import { expect, test } from "bun:test";
import { MIN } from "../core/clock";
import type { SourceEvent } from "../records/source";
import type { LifelogConversation } from "../sources/voice-server";
import {
  cutOf,
  type Deletions,
  deletedEventsOf,
  NO_DELETIONS,
} from "./deletions";
import { lifelogUnits } from "./units";

// What he deleted of a day's words: the words a read takes, and the hash that makes that day read again. Made-up turns.

/** A turn of the conversation below: `n` minutes after 10:00 on 25 Oct (UTC), by `name` or by him. */
const said = (n: number, name: string | null, owner = false) => ({
  at: new Date(Date.parse("2026-10-25T10:00:00.000Z") + n * MIN).toISOString(),
  end: null,
  jobId: "job-1",
  marks: [] as string[],
  name,
  owner,
  personId: null,
  seen: null,
  turnIndex: n,
});

const conversation: LifelogConversation = {
  closed: false,
  endedAt: "2026-10-25T10:40:00.000Z",
  id: "00000000-0000-8000-8000-01a1210b4bdf",
  startedAt: "2026-10-25T10:00:00.000Z",
  turns: [said(0, null, true), said(5, "Gaston"), said(30, "Jean (Me)")],
};

const none = new Set<string>();

const msg = (over: Partial<SourceEvent>): SourceEvent => ({
  at: "2026-10-09T10:00:00.000Z",
  chat: "!chat:matrix",
  chatName: "Dad",
  fromMe: false,
  id: "line:!chat/1",
  sender: "+33600000002",
  source: "line",
  text: "Can you call the plumber today?",
  ...over,
});

test("his deletion of a turn, or of words in it, moves its day's hash, so the day is read again (the words as he deleted them)", () => {
  const hashOf = (deletions: Deletions) =>
    lifelogUnits([conversation], none, deletions)[0]?.unit.hash;
  const plain = hashOf(NO_DELETIONS);
  const turn = "job-1:0@2026-10-25T10:00:00.000Z";
  const cut = cutOf(turn, "the pier at noon", 4, 8);
  expect(hashOf({ ...NO_DELETIONS, refs: new Set([turn]) })).not.toBe(plain);
  expect(hashOf({ ...NO_DELETIONS, cuts: new Map([[turn, [cut]]]) })).not.toBe(
    plain
  );
  // A deletion of another day's turn, or of nothing at all, leaves it as it was.
  expect(hashOf({ ...NO_DELETIONS, refs: new Set(["job-9:0@x"]) })).toBe(plain);
});

test("a source's events come in as he deleted them: a message gone whole is dropped, a cut's words are blanked", () => {
  const chat = [
    msg({ id: "m1", text: "the pier at noon" }),
    msg({ id: "m2", text: "keep this one" }),
  ] as SourceEvent[];
  const cut = cutOf("msg:whatsapp|m1", "the pier at noon", 0, 4);
  const kept = deletedEventsOf("whatsapp", chat, {
    ...NO_DELETIONS,
    cuts: new Map([["msg:whatsapp|m1", [cut]]]),
  });
  expect(kept.map((e) => e.text)).toEqual([
    "    pier at noon",
    "keep this one",
  ]);
  expect(
    deletedEventsOf("whatsapp", chat, {
      ...NO_DELETIONS,
      refs: new Set(["msg:whatsapp|m1"]),
    }).map((e) => e.id)
  ).toEqual(["m2"]);
  // Another source's message of the same id is another line.
  expect(
    deletedEventsOf("mail", chat, {
      ...NO_DELETIONS,
      refs: new Set(["msg:whatsapp|m1"]),
    }).length
  ).toBe(2);
});
