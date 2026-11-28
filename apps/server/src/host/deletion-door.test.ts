import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl } from "../core/files";
import { setSettings, settings } from "../core/settings";
import { readChats } from "../memory/chat-events";
import { deletionsOf, isDeleted } from "../memory/deletions";
import { wroteSince } from "../memory/draft-send";
import { reindex } from "../memory/index-writer";
import {
  CORRECTIONS,
  HISTORIES,
  INDEX,
  OBSERVATIONS,
  observationStatusOf,
  PERSONAS,
  readCorrections,
  readIndex,
  readObservationStatusInputs,
  readUnitsOf,
  SITUATIONS,
  UNITS,
} from "../memory/memory-files";
import { writePassages } from "../memory/passages";
import { unit } from "../memory/record-fixtures";
import { deletedReadOf, tablesOf } from "../memory/sources";
import { writeUnits } from "../memory/unit-writer";
import { chatHits, fetchOf, transcripts } from "../memory/words";
import { dayRange } from "../memory/zones";
import { readPersona } from "../personal/personas";
import {
  type Correction,
  Correction as CorrectionSchema,
  Observation,
} from "../records/observation";
import type { SourceEvent } from "../records/source";
import type { Descriptor } from "../sources/contract";
import {
  conversation,
  pageFixture,
  turnFixture,
  voiceServer,
} from "../sources/store-fixtures";
import { apply, openStore, turnRef, WATCH } from "../sources/voice-server";
import { deleteFromMemoryAndTodoItems } from "./deletion-door";

// A deletion end to end, on made-up data: a voice turn's words cut in a recorded conversation, previewed, refused on a
// wrong digest, then written; and a chat message gone whole. What he loses is gone from every read of the words (the
// transcript, the unit read again, the facts, the index, the passages), before and after a night that re-read the day,
// with the copies in the source still there for a draft that must send exactly what he approved.

const DAY = "2026-10-14";
const AT = "2026-10-14T09:00:00.000Z";
const AT2 = "2026-10-14T09:01:00.000Z";
const JOB = "job-1";
const TURN = turnRef(JOB, 0, AT);
const OLD_HASH = "0123456789abcdef";
const KIT = "person:test-kit";
const DIGEST = /^[0-9a-f]{16}$/;
const MADE_BY = {
  engine: "claude",
  model: "m",
  prompt: "p",
  run: "r",
} as const;
const ENGINE = "claude" as const;

const said = (text: string) => ({ speakerId: "speaker_0", text });

/** The voice server stand-in: one closed conversation of two turns, its transcript held apart as the voice server holds it. */
const WORDS = "Meet me at the pier at noon.";
/** Each word of `WORDS` with its milliseconds into the turn: The voice server's own timing of a turn's words. */
const TIMED = [
  [0, 1000, 5],
  [1000, 2000, 3],
  [2000, 3000, 3],
  [3000, 3500, 4],
  [3500, 4500, 5],
  [4500, 5500, 3],
  [5500, 6500, 5],
];

const fakeVoiceServer = () =>
  voiceServer({
    [`/transcription-jobs/${JOB}/transcript`]: () => ({
      turns: [said(WORDS), said("Bring the drawings.")],
    }),
    // The first turn's timings stop early: a span past them keeps its words and says the rest went unread.
    "/turns/clip": () => ({
      at: AT,
      audio: null,
      text: WORDS,
      until: "2026-10-14T09:00:05.000Z",
      words: TIMED,
    }),
  });

/** The watch store with that conversation: two turns, first at `AT`, nobody named. */
function recorded() {
  const store = openStore();
  apply(
    store,
    pageFixture({
      conversations: [conversation("c1", { endAt: AT2, startAt: AT })],
      turns: [
        { ...turnFixture(0, AT, null, null), endAt: AT2 },
        turnFixture(1, AT2, null, null),
      ],
    })
  );
  store.db.close();
}

/** One fact read from the turn's words, as extraction writes it. */
const fact = (id: string, unitHash: string) => ({
  area: null,
  at: AT,
  confidence: 1,
  date: DAY,
  id,
  importance: 2,
  madeBy: { engine: ENGINE, model: "m", prompt: "p", run: "r", unitHash },
  quote: "the pier",
  schemaVersion: 1 as const,
  source: { channel: "lifelog" as const, ref: TURN },
  speaker: "person:me",
  subjects: [],
  text: "He meets someone at the pier at noon.",
  type: "to_do" as const,
  tz: "Europe/Berlin",
  unit: "unit_0000000000aa",
  validFrom: null,
  validTo: null,
  when: null,
});

/** The files this test makes, removed at the end: the data repo is the tests' own copy, never his. */
const MADE = [
  join(PERSONAS, "test-kit.json"),
  join(HISTORIES, "test-kit.json"),
  join(SITUATIONS, "test-kit.json"),
  join(UNITS, `${DAY}.jsonl`),
  join(OBSERVATIONS, "2026-10.jsonl"),
];

afterAll(() => {
  for (const path of MADE) {
    rmSync(path, { force: true });
  }
  // What his word left: the tests' own deletions, which no other test may read.
  rmSync(CORRECTIONS, { force: true });
  rmSync(UNITS, { force: true, recursive: true });
  rmSync(OBSERVATIONS, { force: true, recursive: true });
  rmSync(WATCH, { force: true, recursive: true });
  rmSync(INDEX, { force: true });
});

test("a voice turn's words cut, then a message gone: gone from every read, the source's copy still there", async () => {
  const before = settings().sources;
  const server = fakeVoiceServer();
  setSettings({ sources: ["lifelog", "whatsapp"] });
  try {
    recorded();
    // His data: the day's conversation-day, the persona, history and situation of the person it is with, and one fact
    // read from the turn's words before the night reads the day again.
    await writeUnits(
      [DAY],
      [
        unit({
          date: DAY,
          end: AT2,
          hash: OLD_HASH,
          id: "unit_0000000000aa",
          key: "c1",
          people: [KIT],
          refs: [TURN],
          source: "lifelog",
          start: AT,
          title: "Conversation at 11:00",
        }),
      ]
    );
    mkdirSync(PERSONAS, { recursive: true });
    mkdirSync(HISTORIES, { recursive: true });
    mkdirSync(SITUATIONS, { recursive: true });
    await Bun.write(
      join(PERSONAS, "test-kit.json"),
      JSON.stringify({
        built: "2026-10-10T00:00:00.000Z",
        gist: "A carpenter who works early.",
        inputs: "a",
        lines: [],
        madeBy: MADE_BY,
        page: KIT,
        schemaVersion: 2,
      })
    );
    await Bun.write(
      join(HISTORIES, "test-kit.json"),
      JSON.stringify({ months: [], schemaVersion: 1, story: null })
    );
    await Bun.write(
      join(SITUATIONS, "test-kit.json"),
      JSON.stringify({
        built: "2026-10-10T00:00:00.000Z",
        inputs: "a",
        lines: [],
        madeBy: MADE_BY,
        page: KIT,
        schemaVersion: 1,
      })
    );
    const beforeFact = fact("obs_00000000000a", OLD_HASH);
    mkdirSync(OBSERVATIONS, { recursive: true });
    appendJsonl(join(OBSERVATIONS, "2026-10.jsonl"), Observation, [beforeFact]);
    expect(readPersona(KIT)?.page).toBe(KIT);
    expect(
      observationStatusOf(
        beforeFact,
        await readObservationStatusInputs(readCorrections())
      ).state
    ).toBe("active");

    // A chat message, as its source gives it: the copy a draft sends into.
    const chat = [
      {
        at: AT,
        chat: "120@g.us",
        chatName: "Team",
        fromMe: false,
        id: "S1",
        sender: "+66600000001",
        source: "whatsapp" as const,
        text: "meet at the pier",
      },
      {
        at: AT2,
        chat: "120@g.us",
        chatName: "Team",
        fromMe: false,
        id: "S2",
        sender: "+66600000001",
        source: "whatsapp" as const,
        text: "see you then",
      },
    ] as SourceEvent[];
    const source = { name: "whatsapp", read: () => chat };
    const window = { from: DAY, to: DAY };
    const range = dayRange(DAY, DAY);
    const readers = { whatsapp: () => chat };
    writePassages(chat, window, [], readers);
    expect((await chatHits("pier", range)).join("\n")).toContain(
      "meet at the pier"
    );
    // The night's index: his fact is searchable.
    await reindex();
    const texts = () =>
      readIndex((db) =>
        db
          .query<{ text: string }, []>("select text from observations")
          .all()
          .map((r) => r.text)
      ) ?? [];
    expect(texts().join("\n")).toContain("pier");

    // The preview: what he would lose, and the digest to repeat. Nothing is written.
    const ask = {
      cuts: [{ quote: "the pier", ref: TURN }],
      refs: [],
      said: "that goes",
    };
    const preview = await deleteFromMemoryAndTodoItems(ask);
    expect("askAgain" in preview ? preview.confirm : "").toMatch(DIGEST);
    expect("reaches" in preview && preview.reaches.units).toEqual([
      "unit_0000000000aa",
    ]);
    // The persona, its history's month and its situation were shown the words: they are hidden until redone.
    expect("reaches" in preview && preview.reaches.shown).toEqual([
      `history:${KIT}:2026-10`,
      `persona:${KIT}`,
      `situation:${KIT}`,
    ]);
    expect(readCorrections().some((c) => c.kind === "deleted")).toBe(false);
    // A digest of another set writes nothing, and previews again.
    const wrong = await deleteFromMemoryAndTodoItems({
      ...ask,
      confirm: "0".repeat(16),
    });
    expect("askAgain" in wrong).toBe(true);
    expect(readCorrections().some((c) => c.kind === "deleted")).toBe(false);
    // Before the write, the words are still there.
    expect((await transcripts([{ jobId: JOB }])).get(JOB)?.[0]?.text).toContain(
      "pier"
    );

    const confirm = "reaches" in preview ? preview.confirm : "";
    const done = await deleteFromMemoryAndTodoItems({ ...ask, confirm });
    // A cut leaves its line: what goes whole is nothing he named.
    expect("reindexed" in done && done.refs).toEqual([]);
    expect("reindexed" in done && done.reindexed).toBe(true);

    // The record: the places and the digest of what was there, the hash the unit had, and the reads shown it.
    const [line] = readCorrections().filter(
      (c): c is Extract<Correction, { kind: "deleted" }> => c.kind === "deleted"
    );
    expect(line?.refs).toEqual([]);
    expect(line?.oldHashes).toEqual([OLD_HASH]);
    expect(line?.cuts.map((c) => [c.from, c.to])).toEqual([[11, 19]]);
    expect(line?.shown).toEqual([
      `history:${KIT}:2026-10`,
      `persona:${KIT}`,
      `situation:${KIT}`,
    ]);
    expect(line?.withSources).toBe(false);
    // His words could quote what he deleted: the record keeps their digest, never them.
    expect(line?.said).toMatch(DIGEST);
    expect(line?.said).not.toContain("that goes");

    // The words, once they come in: cut in the transcript, the day read again with the words as he deleted them.
    const cut = (await transcripts([{ jobId: JOB }])).get(JOB);
    // Its places hold, its words blank; nothing after it moved.
    expect(cut?.[0]?.text).toBe("Meet me at          at noon.");
    expect(cut?.[1]?.text).toBe("Bring the drawings.");
    expect(readUnitsOf([DAY]).some((u) => u.hash === OLD_HASH)).toBe(false);
    // A derived read shown the words is hidden until it is redone.
    expect(readPersona(KIT)).toBeNull();
    // What was read from them is gone, never replaced: his fact was read under the hash the cut changed.
    const status = await readObservationStatusInputs(readCorrections());
    expect(observationStatusOf(beforeFact, status).state).toBe("deleted");
    // The index (the door rebuilt it) no longer holds it.
    expect(texts().join("\n")).not.toContain("pier");

    // A message gone whole: dropped by every read of the source, and still there for a draft that must send it.
    appendJsonl(CORRECTIONS, CorrectionSchema, [
      {
        at: AT,
        cuts: [],
        kind: "deleted",
        oldHashes: [],
        refs: ["msg:whatsapp|S1"],
        said: "that message too",
        schemaVersion: 1,
        shown: [],
        withSources: false,
      },
    ]);
    const readNow = deletedReadOf("whatsapp", source.read);
    expect(readNow(new Date(0)).map((e) => e.id)).toEqual(["S2"]);
    // Every reader of the sources' tables sees the message gone, `read_chats` among them: the table's read is guarded.
    const chatSource = {
      chatDays: 1,
      kind: "chat",
      label: "WhatsApp",
      name: "whatsapp",
      read: source.read,
    } as unknown as Descriptor;
    expect(
      readChats(range, tablesOf([chatSource]).CHATS).events.map((e) => e.id)
    ).toEqual(["S2"]);
    // A fact read from it again, under a new id and its unit's new hash, stays hidden: `withSources` false records that
    // the copies in the sources stay as they are, never that what memory reads from them comes back.
    const again = {
      ...fact("obs_00000000000b", "fedcba9876543210"),
      source: { channel: "whatsapp" as const, ref: "msg:whatsapp|S1" },
    };
    expect(
      observationStatusOf(
        again,
        await readObservationStatusInputs(readCorrections())
      ).state
    ).toBe("deleted");
    // A draft's own read is raw: his Send goes into the chat as he approved it.
    const sources = [
      { ...source, kind: "chat", label: "WhatsApp" },
    ] as unknown as Parameters<typeof wroteSince>[1];
    expect(
      wroteSince(
        [
          {
            draft: { channel: "whatsapp", chat: "120@g.us" },
            since: new Date(0),
          },
        ],
        sources
      )[0]?.map((e) => e.id)
    ).toEqual(["S1", "S2"]);
    // The passages republished over the guarded read no longer hold its words.
    writePassages(readNow(new Date(0)), window, [], {
      whatsapp: () => readNow(new Date(0)),
    });
    expect((await chatHits("pier", range)).join("\n")).not.toContain("pier");

    // A call's span over that turn: its clip holds the voice server's words at places of its own, so a line he cut shows none.
    const page = await fetchOf("c1", 0, 200, openStore, {
      at: AT,
      until: "2026-10-14T09:00:30.000Z",
    });
    expect(page).not.toContain("Meet me at");
    expect(page).not.toContain("the pier");

    // A unit gone whole: `fetch` opens nothing of it any more.
    appendJsonl(CORRECTIONS, CorrectionSchema, [
      {
        at: AT,
        cuts: [],
        kind: "deleted",
        oldHashes: [],
        refs: ["unit_0000000000aa"],
        said: "that day goes",
        schemaVersion: 1,
        shown: [],
        withSources: false,
      },
    ]);
    expect(await fetchOf("unit_0000000000aa")).toContain("no unit");
  } finally {
    server.close();
    setSettings({ sources: before });
  }
});

test("a chapter unit is never read again: a deletion names its turn, never its hash", async () => {
  const before = settings().sources;
  const server = fakeVoiceServer();
  setSettings({ sources: ["lifelog"] });
  try {
    recorded();
    // A chapter as the voice server stored it before conversation-days: its own summary, and a hash no read ever rebuilds.
    const chapter = "unit_0000000000bb";
    const chapterHash = "aaaaaaaaaaaaaaaa";
    await writeUnits(
      [DAY],
      [
        unit({
          date: DAY,
          end: AT2,
          hash: chapterHash,
          id: chapter,
          key: "c1",
          refs: [TURN],
          source: "lifelog",
          start: AT,
          summary: "A chapter about the pier.",
          title: "Chapter 1",
        }),
      ]
    );
    const ofChapter = (id: string, ref: string) => ({
      id,
      ref,
      unit: chapter,
      unitHash: chapterHash,
    });
    const ask = { refs: [TURN], said: "that turn goes" };
    const preview = await deleteFromMemoryAndTodoItems(ask);
    const confirm = "reaches" in preview ? preview.confirm : "";
    await deleteFromMemoryAndTodoItems({ ...ask, confirm });

    const line = readCorrections()
      .filter(
        (c): c is Extract<Correction, { kind: "deleted" }> =>
          c.kind === "deleted"
      )
      .at(-1);
    // The chapter's hash is never hidden: chapters are never read again, so every fact of it would be gone for good.
    expect(line?.oldHashes).toEqual([]);
    const d = deletionsOf(readCorrections());
    // Only what cites the deleted turn goes; the chapter's other facts stand.
    expect(isDeleted(ofChapter("obs_00000000000c", TURN), d)).toBe(true);
    expect(isDeleted(ofChapter("obs_00000000000d", "c1"), d)).toBe(false);
  } finally {
    server.close();
    setSettings({ sources: before });
  }
});
