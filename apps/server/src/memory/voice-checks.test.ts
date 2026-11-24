import { expect, test } from "bun:test";
import { cutOf, NO_DELETIONS } from "./deletions";
import { shownClipsOf, voiceChecksOf } from "./voice-checks";
import type { GuessedQueueItem } from "./voice-guesses";

// Made-up people. His ask of 22 Nov: each guess on a voice card shows why it was guessed.
const NAMES = new Map([
  ["person:dana", "Dana"],
  ["person:kofi", "Kofi"],
]);
const people = {
  nameOf: (r: string) => NAMES.get(r) ?? r,
  names: NAMES,
  partyOf: (r: string) => ({ name: NAMES.get(r) ?? r, ref: r }),
  refOf: (r: string) => r,
  resolve: () => null,
} as unknown as Parameters<typeof voiceChecksOf>[0];

test("a voice card lists each guess known today with its why, null for a guess made before whys", () => {
  const item = {
    clips: [],
    conversations: 1,
    evidence: [],
    guessed: ["person:dana", "person:kofi", "person:zed"],
    id: "v1",
    isLikely: false,
    kind: "new_person",
    likely: [],
    name: null,
    personId: null,
    voices: [{ conversationId: "c1", jobId: "job-1", speakerLabel: "A" }],
    whys: { "person:dana": "Instagram, 22:40: on my way" },
    words: 40,
  } as unknown as GuessedQueueItem;
  const [card] = voiceChecksOf(people, [item]);
  expect(card?.check.voiceGuesses).toEqual([
    {
      person: { name: "Dana", ref: "person:dana" },
      why: "Instagram, 22:40: on my way",
    },
    { person: { name: "Kofi", ref: "person:kofi" }, why: null },
  ] as never);
});

test("a clip or an evidence line of a recording he deleted words in never reaches a card, however it was indexed", () => {
  const item = {
    clips: [
      {
        at: "2026-10-14T10:00:05.000Z",
        audio: { end: 4, jobId: "job-1", start: 1 },
        text: "hello there",
        until: null,
        words: [[0, 300, 5]],
      },
    ],
    evidence: [
      { at: "2026-10-14T10:00:05.000Z", conversationId: "c1", text: "hello" },
    ],
    voices: [{ conversationId: "c1", jobId: "job-1", speakerLabel: "A" }],
  };
  expect(shownClipsOf(item, NO_DELETIONS)).toEqual({
    clips: item.clips,
    evidence: item.evidence,
  });
  // A turn of that recording gone, or words cut in it: evidence names no turn, so its recording answers for it.
  for (const d of [
    { ...NO_DELETIONS, refs: new Set(["job-1:7"]) },
    {
      ...NO_DELETIONS,
      cuts: new Map([["job-1:0", [cutOf("job-1:0", "hello there", 0, 5)]]]),
    },
  ]) {
    expect(shownClipsOf(item, d)).toEqual({ clips: [], evidence: [] });
  }
});
