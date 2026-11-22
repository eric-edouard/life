import { expect, test } from "bun:test";
import { voiceChecksOf } from "./voice-checks";
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
