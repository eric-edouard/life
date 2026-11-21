import { expect, test } from "bun:test";
import type { NamingQueueItem } from "../sources/lifelog-voices";
import type { SpokenPart } from "./spoken-conversations";
import { unnamedTurnKey } from "./units";
import {
  isGroupDue,
  LIVE_GROUP_WORDS,
  recentConversationsOf,
} from "./voice-naming-on-arrival";

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

/** A part of recording `job` whose lines are each a voice label with its words. */
const partOf = (job: string, lines: [string, string][]): SpokenPart => ({
  at: "2026-11-21T01:27:00.000Z",
  chars: 0,
  day: "2026-11-21",
  keys: lines.map((_, n) =>
    unnamedTurnKey(
      `${job}:${n}@2026-11-21T01:27:0${n}.000Z`,
      lines[n]?.[0] ?? ""
    )
  ),
  lines: [],
  people: [],
  ref: "",
  units: [],
  until: "2026-11-21T01:30:00.000Z",
  voices: lines.map(([label, text]) => ({
    from: null,
    label,
    name: null,
    owner: false,
    text,
    time: "01:27",
  })),
});

const itemOf = (voices: [string, string][]) =>
  ({
    voices: voices.map(([jobId, speakerLabel]) => ({
      conversationId: "c1",
      jobId,
      speakerLabel,
    })),
  }) as NamingQueueItem;

test("a group is due once it said LIVE_GROUP_WORDS in this conversation, across its recordings, until a naming line holds one of its voices", () => {
  const parts = [
    partOf("job-1", [["speaker_1", words(LIVE_GROUP_WORDS - 50)]]),
    partOf("job-2", [["speaker_0", words(50)]]),
  ];
  const zara = itemOf([
    ["job-1", "speaker_1"],
    ["job-2", "speaker_0"],
    // A voice of an earlier meeting adds no words here.
    ["job-0", "speaker_3"],
  ]);
  expect(isGroupDue(parts, [zara], new Set())).toBe(true);
  expect(isGroupDue(parts, [zara], new Set(["job-1 speaker_1"]))).toBe(false);
  expect(isGroupDue(parts.slice(0, 1), [zara], new Set())).toBe(false);
  // A group of an earlier meeting only (its words counted elsewhere) is never due here.
  expect(isGroupDue(parts, [itemOf([["job-0", "speaker_3"]])], new Set())).toBe(
    false
  );
});

test("the watcher's voice read is cut as the night cuts it, closed only when lifelog closed every conversation in it", () => {
  const turn = (jobId: string, at: string) => ({
    at,
    end: at,
    jobId,
    name: null,
    owner: false,
    personId: null,
    seen: at,
    turnIndex: 0,
  });
  const unit = (id: string, key: string) =>
    ({ unit: { id, key } }) as Parameters<
      typeof recentConversationsOf
    >[0]["built"][number];
  const talks = recentConversationsOf({
    built: [unit("u1", "c1"), unit("u2", "c2"), unit("u3", "c3")],
    closed: new Set(["c1", "c3"]),
    turns: new Map([
      ["u1", [turn("job-1", "2026-11-21T01:00:00.000Z")]],
      // Two minutes on: the same spoken conversation, though lifelog's is another and still open.
      ["u2", [turn("job-2", "2026-11-21T01:02:00.000Z")]],
      ["u3", [turn("job-3", "2026-11-21T03:00:00.000Z")]],
    ]),
  });
  expect(talks.map((t) => [t.turns.length, t.closed])).toEqual([
    [2, false],
    [1, true],
  ]);
  expect(talks[0]?.ref).toBe(
    "job-1:0@2026-11-21T01:00:00.000Z job-2:0@2026-11-21T01:02:00.000Z"
  );
});
