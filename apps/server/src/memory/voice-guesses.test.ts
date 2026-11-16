import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSettings, settings } from "../core/settings";
import type { ReadReply } from "../records/read-reply";
import { apply, readConversations } from "../sources/lifelog";
import {
  conversation,
  lifelogServer,
  lifelogStore,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { READ_REPLIES } from "./memory-files";
import { READS, storeReply } from "./read-replies";
import type { Truth } from "./read-truth";
import { type Built, lifelogUnits, unnamedTurnKey } from "./units";
import { voiceGuessesNow, withGuessesShown } from "./voice-guesses";
import { fetchOf, voiceLines, voiceText } from "./words";

// Made-up people and recordings. Stored guesses are written as lines of a trial folder, as the voice naming writes them.

const where = mkdtempSync(join(tmpdir(), "voice-guesses-"));
afterAll(() => rmSync(where, { force: true, recursive: true }));
const NAMES = new Map([["person:dana", "Dana"]]);
const people = {
  nameOf: (r: string) => NAMES.get(r) ?? r,
  names: NAMES,
  refOf: (r: string) => r,
};
const at = (m: number) => `2026-10-10T10:${String(m).padStart(2, "0")}:00.000Z`;
const ref = (n: number) => `job-1:${n}@${at(n)}`;
const key = (n: number, label: string) => unnamedTurnKey(ref(n), label);
// Line 0 is his (named key), 1 and 3 are voice speaker_1 (V1), 2 is speaker_2 (V2).
const MESSAGES = [
  `${ref(0)} me`,
  key(1, "speaker_1"),
  key(2, "speaker_2"),
  key(3, "speaker_1"),
];
const entry = (o: Record<string, unknown> = {}) => ({
  confidence: "sure",
  lines: [1, 3],
  person: "person:dana",
  voice: "V1",
  ...o,
});
let made = 0;
const line = (voices: unknown[], when: string, folder = where) => {
  made += 1;
  storeReply(
    {
      at: when,
      madeBy: {
        engine: "codex",
        model: "test",
        prompt: READS.voice_naming.prompt,
        run: `r${made}`,
      },
      messages: MESSAGES,
      promptDigest: "0123456789abcdef",
      read: "voice_naming",
      reply: { voices },
      schemaVersion: 1,
      starts: [0],
    } as ReadReply,
    at(0),
    folder
  );
};
const guessOf = (k: string) =>
  voiceGuessesNow(people, where).get(k)?.person ?? null;

test("a guess is kept for each turn of its voice, the newest wins, and an entry that no longer checks is dropped", () => {
  line(
    [entry(), entry({ lines: [2], person: "person:dana", voice: "V2" })],
    "2026-10-11T00:00:00.000Z"
  );
  expect(guessOf(MESSAGES[1] as string)).toBe("person:dana");
  expect(guessOf(MESSAGES[3] as string)).toBe("person:dana");
  expect(guessOf(MESSAGES[2] as string)).toBe("person:dana");
  // A newer line that is a guess of `me` wins, even for one turn only...
  line([entry({ person: "me" })], "2026-10-12T00:00:00.000Z");
  expect(guessOf(MESSAGES[1] as string)).toBe("me");
  expect(guessOf(MESSAGES[2] as string)).toBe("person:dana");
  // ...but a newer entry that is dropped never overrides it: a cited line absent, one of another voice (line 2 is V2),
  // or one that is not an unnamed turn (line 0 is his).
  for (const bad of [
    entry({ lines: [1, 9] }),
    entry({ lines: [1, 2] }),
    entry({ lines: [0] }),
  ]) {
    line([bad], "2026-10-13T00:00:00.000Z");
    expect(guessOf(MESSAGES[1] as string)).toBe("me");
  }
});

test("when the newest guess names a person not known now the key has none, never an older guess", () => {
  const other = mkdtempSync(join(tmpdir(), "voice-guesses-ghost-"));
  try {
    line([entry()], "2026-10-11T00:00:00.000Z", other);
    line(
      [entry({ person: "person:ghost" })],
      "2026-10-12T00:00:00.000Z",
      other
    );
    const now = voiceGuessesNow(people, other);
    expect(now.get(MESSAGES[1] as string)).toBeUndefined();
  } finally {
    rmSync(other, { force: true, recursive: true });
  }
});

const turn = (n: number, label: string, from?: string) => ({
  from,
  ref: ref(n),
  speaker: from ? "unknown:Plumber" : `unknown:${label}`,
  text: `words ${n}`,
  voice: label,
});

test("with the setting off nothing is shown; on, a sure or likely guess follows an unnamed speaker, and only a turn still unnamed", () => {
  const lines = [
    turn(1, "speaker_1"),
    turn(2, "speaker_2"),
    turn(3, "speaker_1", "p1"),
    { ...turn(0, "speaker_0"), speaker: "me" },
  ];
  const shown = () =>
    withGuessesShown(lines, people, where).map((l) => l.speaker);
  const before = settings().voiceGuessesShown;
  try {
    setSettings({ voiceGuessesShown: null });
    expect(shown()).toEqual(lines.map((l) => l.speaker));
    setSettings({ voiceGuessesShown: true });
    // Turn 1 is `me` (the newest line), turn 2 is Dana; turn 3 was named since (it has an author): its old key is never looked up.
    expect(shown()).toEqual([
      "unknown:speaker_1 (probably me)",
      "unknown:speaker_2 (probably Dana)",
      "unknown:Plumber",
      "me",
    ]);
    line(
      [
        entry({ confidence: "weak", person: "person:dana" }),
        entry({
          confidence: "likely",
          lines: [2],
          person: "unknown",
          voice: "V2",
        }),
      ],
      "2026-10-14T00:00:00.000Z"
    );
    expect(shown().slice(0, 2)).toEqual([
      "unknown:speaker_1",
      "unknown:speaker_2",
    ]);
  } finally {
    setSettings({ voiceGuessesShown: before ?? null });
  }
});

// The guarantee: with the setting on and a stored guess, only `fetch`'s display shows it; the lines extraction and the
// episodes read stay `unknown:` with no guess in their words.
test("a guess shows in fetch only: the lines the other steps read never carry it", async () => {
  const server = lifelogServer({
    "/transcription-jobs/job-1/transcript": () => ({
      turns: ["Allo", "Salut"].map((text) => ({
        speakerId: "speaker_0",
        text,
      })),
    }),
  });
  const open = () => {
    const store = lifelogStore();
    apply(
      store,
      pageFixture({
        conversations: [conversation("c1")],
        turns: [
          turnFixture(0, at(0), null, null),
          turnFixture(1, at(1), null, null),
        ],
      })
    );
    return store;
  };
  const before = settings().voiceGuessesShown;
  try {
    setSettings({ voiceGuessesShown: true });
    // The default store of guesses is his data's copy of the tests: one guess for turn 0 only.
    storeReply(
      {
        at: "2026-10-11T00:00:00.000Z",
        madeBy: {
          engine: "codex",
          model: "test",
          prompt: READS.voice_naming.prompt,
          run: "r",
        },
        messages: [key(0, "speaker_0")],
        promptDigest: "0123456789abcdef",
        read: "voice_naming",
        reply: {
          voices: [
            { confidence: "sure", lines: [0], person: "me", voice: "V1" },
          ],
        },
        schemaVersion: 1,
        starts: [0],
      } as ReadReply,
      at(0)
    );
    const shown = await fetchOf("c1", 0, 10, open);
    expect(shown).toContain("unknown:speaker_0 (probably me): Allo");
    expect(shown).toContain("unknown:speaker_0: Salut");
    const read = voiceLines(
      [
        {
          at: at(0),
          end: null,
          jobId: "job-1",
          name: null,
          owner: false,
          personId: null,
          seen: null,
          turnIndex: 0,
        },
      ],
      new Map([["job-1", [{ speakerId: "speaker_0", text: "Allo" }]]]),
      () => null
    );
    expect(read[0]?.speaker).toBe("unknown:speaker_0");
    expect(read[0]?.speakerName).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain("probably");
    // The episodes' read of the same conversation: his unnamed voice, no guess in its words.
    const [day] = lifelogUnits(
      readConversations(open(), new Date(0)),
      new Set()
    );
    const [episode] = await voiceText(
      [day as Built],
      () => null,
      { people: [] } as unknown as Truth,
      open
    );
    expect(episode?.text).toContain("speaker_0: Allo");
    expect(episode?.text).not.toContain("probably");
  } finally {
    setSettings({ voiceGuessesShown: before ?? null });
    rmSync(READ_REPLIES, { force: true, recursive: true });
    server.close();
  }
});
