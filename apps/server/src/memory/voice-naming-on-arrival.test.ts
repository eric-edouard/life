import { expect, test } from "bun:test";
import type { NamingQueueItem } from "../sources/voice-speakers";
import type { SpokenPart } from "./spoken-conversations";
import { unnamedTurnKey } from "./units";
import {
  isGroupDue,
  LIVE_GROUP_WORDS,
  NAMINGS_A_DAY,
  nameVoicesOnArrival,
  type Outside,
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
      // Two minutes on: the same spoken conversation, though the voice server's is another and still open.
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

// The pass itself, with every outside read and call injected: made-up recording job-1, one voice group in its queue.
const AT = "2026-11-21T01:00:00.000Z";
const turn = {
  at: AT,
  end: AT,
  jobId: "job-1",
  name: null,
  owner: false,
  personId: null,
  seen: AT,
  turnIndex: 0,
};
const voiceRead = (isClosed: boolean) =>
  ({
    built: [{ unit: { id: "u1", key: "c1" } }],
    closed: new Set(isClosed ? ["c1"] : []),
    turns: new Map([["u1", [turn]]]),
  }) as unknown as Parameters<typeof nameVoicesOnArrival>[0];

/** The pass with a group of `count` words, the day's calls so far `today`; `made` counts the model's calls. */
function pass(
  voice: Parameters<typeof nameVoicesOnArrival>[0],
  count: number,
  examined: Set<string>,
  { today = 0 }: { today?: number } = {}
) {
  const made = { calls: 0 };
  const outside: Partial<Outside> = {
    callsToday: () => Promise.resolve(today),
    isOnline: () => Promise.resolve(true),
    isWorthNaming: () => true,
    near: () =>
      Promise.resolve({ events: [], failed: [], since: new Date(AT) }),
    queue: () => Promise.resolve([itemOf([["job-1", "speaker_1"]])]),
    spoken: () =>
      Promise.resolve([partOf("job-1", [["speaker_1", words(count)]])]),
    voiceNaming: () => {
      made.calls += 1;
      return Promise.resolve({ calls: 1, stored: 1 }) as never;
    },
    work: () => Promise.resolve({ asked: [{}], counts: {} }) as never,
  };
  const people = { resolve: () => null } as never;
  return {
    made,
    run: () => nameVoicesOnArrival(voice, people, examined, "unused", outside),
  };
}

test("a closed conversation is asked once, however many passes see it", async () => {
  const examined = new Set<string>();
  const first = pass(voiceRead(true), 10, examined);
  expect(await first.run()).toBe(1);
  expect(examined.size).toBe(1);
  const again = pass(voiceRead(true), 10, examined);
  expect(await again.run()).toBe(0);
  expect(again.made.calls).toBe(0);
});

test("a conversation still open makes no call under LIVE_GROUP_WORDS, and one at it", async () => {
  const short = pass(voiceRead(false), LIVE_GROUP_WORDS - 1, new Set());
  expect(await short.run()).toBe(0);
  expect(short.made.calls).toBe(0);
  const long = pass(voiceRead(false), LIVE_GROUP_WORDS, new Set());
  expect(await long.run()).toBe(1);
  expect(long.made.calls).toBe(1);
});

test("at the day's cap no call is made, and the conversation stays unexamined for the next pass", async () => {
  const examined = new Set<string>();
  const capped = pass(voiceRead(true), 10, examined, { today: NAMINGS_A_DAY });
  expect(await capped.run()).toBe(0);
  expect(capped.made.calls).toBe(0);
  expect(examined.size).toBe(0);
});
