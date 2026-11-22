import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSettings, settings } from "../core/settings";
import type { ReadReply } from "../records/read-reply";
import { apply, readConversations } from "../sources/lifelog";
import type { NamingQueueItem } from "../sources/lifelog-voices";
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
import {
  conversationOf,
  voiceGuessesNow,
  withGuessesShown,
  withVoiceGuesses,
} from "./voice-guesses";
import { voiceIdOf, voiceSuggestionOf } from "./who";
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
const line = (
  voices: unknown[],
  when: string,
  folder = where,
  firstAt = at(0),
  prompt = READS.voice_naming.prompt
) => {
  made += 1;
  storeReply(
    {
      at: when,
      madeBy: {
        engine: "codex",
        model: "test",
        prompt,
        run: `r${made}`,
      },
      messages: MESSAGES,
      promptDigest: "0123456789abcdef",
      read: "voice_naming",
      reply: { voices },
      schemaVersion: 1,
      starts: [0],
    } as ReadReply,
    firstAt,
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

test("a guess an older prompt made stays one until a newer line replaces it", () => {
  const folder = `${where}-older`;
  line(
    [entry()],
    "2026-10-11T00:00:00.000Z",
    folder,
    at(0),
    "memory-voice-naming.v1"
  );
  expect(
    voiceGuessesNow(people, folder).get(MESSAGES[1] as string)?.person
  ).toBe("person:dana");
  line([entry({ person: "me" })], "2026-10-12T00:00:00.000Z", folder);
  expect(
    voiceGuessesNow(people, folder).get(MESSAGES[1] as string)?.person
  ).toBe("me");
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

test("a voice card asks about the one person the group's sure or likely guesses name and lifelog's suggestion does not contradict, known to Voice or not", async () => {
  const folder = mkdtempSync(join(tmpdir(), "voice-card-guesses-"));
  try {
    line([entry()], "2026-10-11T00:00:00.000Z", folder);
    // speaker_2's part is filed in an earlier month, as its recording's conversation began then: still read.
    line(
      [
        entry({
          confidence: "likely",
          lines: [2],
          person: "person:kofi",
          voice: "V2",
        }),
      ],
      "2026-10-11T00:00:00.000Z",
      folder,
      "2026-08-01T00:00:00.000Z"
    );
    const item = {
      clips: [],
      likely: ["lf-dana", "lf-kofi"],
      name: null,
      personId: null,
      voices: [
        { jobId: "job-1", speakerLabel: "speaker_1" },
        { jobId: "job-1", speakerLabel: "speaker_2" },
      ],
    } as unknown as NamingQueueItem;
    const months = async () => ["2026-08", "2026-10"];
    const lifelogNames = { "lf-dana": "Dana", "lf-new": "Dana" };
    const [guessed] = await withVoiceGuesses(
      [item],
      folder,
      months,
      async () => lifelogNames
    );
    expect(guessed?.guessed).toEqual(["person:dana", "person:kofi"]);
    // Each item keeps the names of its own ids only.
    expect(guessed?.names).toEqual({ "lf-dana": "Dana" });
    // Only the months its recordings can be filed under are read.
    const [one] = await withVoiceGuesses([item], folder, async () => [
      "2026-10",
    ]);
    expect(one?.guessed).toEqual(["person:dana"]);
    const ids: Record<string, string> = {
      Dana: "person:dana",
      Kofi: "person:kofi",
      "lf-dana": "person:dana",
      "lf-kofi": "person:kofi",
    };
    const who = {
      names: new Map([...NAMES, ["person:kofi", "Kofi"]]),
      refOf: (r: string) => r,
      resolve: (s: string) => ids[s] ?? null,
    };
    const card = (o: Record<string, unknown>) =>
      voiceSuggestionOf(who, { ...item, guessed: ["person:dana"], ...o });
    // Two people guessed: no one.
    expect(voiceSuggestionOf(who, guessed as NamingQueueItem)).toBeNull();
    expect(card({})).toBe("person:dana");
    // Lifelog's heard name agrees, a new person's too; its person or name naming someone else leaves no one.
    expect(card({ kind: "new_person", name: "Dana" })).toBe("person:dana");
    expect(card({ name: "Kofi" })).toBeNull();
    expect(card({ personId: "lf-dana" })).toBe("person:dana");
    // A guess of someone not known today counts for nothing.
    expect(card({ guessed: ["person:dana", "person:zed"] })).toBe(
      "person:dana"
    );
    // Lifelog's suggestion alone, nothing guessed, names no one: its sound or a name heard says nothing of who could be
    // there (a friend living far away, matched by sound to a recording made where he was): "Who is this?".
    expect(card({ guessed: [], kind: "new_person", name: "Dana" })).toBeNull();
    expect(card({ guessed: [], personId: "lf-dana" })).toBeNull();
    // Someone lifelog knows by no id is still asked (his yes of 22 Nov 2026): "Yes" names them to Voice by their name.
    expect(card({ likely: [] })).toBe("person:dana");
    // An id his directory does not know is who lifelog names it (life#963): "Yes" assigns that id, not a new name.
    expect(card({ likely: ["lf-new"] })).toBe("person:dana");
    expect(
      voiceIdOf(who, { likely: ["lf-new"], personId: null }, "person:dana")
    ).toBeUndefined();
    expect(
      voiceIdOf(
        who,
        { likely: ["lf-new"], names: lifelogNames, personId: null },
        "person:dana"
      )
    ).toBe("lf-new");
    expect(card({ name: null, names: lifelogNames, personId: "lf-new" })).toBe(
      "person:dana"
    );
    // A month file torn mid-line: the read throws (the inbox keeps lifelog's suggestion, an answer refuses).
    appendFileSync(join(folder, "2026-08.jsonl"), "{not json\n");
    await expect(withVoiceGuesses([item], folder, months)).rejects.toThrow();
  } finally {
    rmSync(folder, { force: true, recursive: true });
  }
});

// His ask of 22 Nov: a voice's clip names the conversation it was heard in (the test zones: Lagos, UTC+1).
test("a clip's conversation is the narrowest episode holding it, none when no episode with times does", () => {
  const episode = (
    title: string,
    start: string | null,
    end: string | null
  ) => ({
    end,
    start,
    title,
  });
  const episodes = [
    episode("Day in town", "2026-10-30 08:00", "2026-10-30 23:00"),
    episode("Lunch with Ana", "2026-10-30 12:30", "2026-10-30 14:00"),
    episode("A day", "2026-10-30", null),
  ];
  expect(conversationOf(episodes, "2026-10-30T12:00:00.000Z")).toBe(
    "Lunch with Ana"
  );
  expect(conversationOf(episodes, "2026-10-30T20:00:00.000Z")).toBe(
    "Day in town"
  );
  expect(conversationOf(episodes, "2026-10-31T09:00:00.000Z")).toBeNull();
});
