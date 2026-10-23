import { countRows } from "@life/voice-db";
// The wire the phone reads, as real answers: each test writes what the server answers to
// `fixtures/wire/`, and Kit's `WireTests` decode the same files with the phone's types. A drift on
// either side fails the gate. Run with WRITE_WIRE=1 to rewrite them after a deliberate change.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chapters,
  conversations,
  heartbeats,
  intelligenceRuns,
  people,
  sources,
  speakerAssignments,
  speechFragments,
  transcriptionJobs,
  transcripts,
} from "@life/voice-db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { memoryAudioStore } from "./audio-store";
import { logChange } from "./change-log";
import { sha256Hex } from "./config";
import { storeHeartbeat } from "./diagnostics";
import { PARSER_VERSION } from "./elevenlabs";
import { storeHistory } from "./location";
import { addQuietRange, storeMacHeard } from "./quiet-ranges";
import { services } from "./services";
import { storeSubscriptionUsage } from "./subscriptions";
import { PROMPT_VERSION } from "./summary-calls";
import {
  mapJob,
  OWNER_TOKEN,
  oggOpus,
  storedResult,
  testConfig,
  testDb,
} from "./testing";

let env: Awaited<ReturnType<typeof testDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  env = testDb();
  app = createApp(
    services(testConfig("http://localhost:1"), env.db, {
      audio: memoryAudioStore(),
      intelligence: null,
      search: null,
    })
  );
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
});

const WIRE = `${import.meta.dir}/../../../fixtures/wire`;

async function expectWire(name: string, value: unknown) {
  const file = Bun.file(`${WIRE}/${name}.json`);
  if (process.env.WRITE_WIRE) {
    await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  expect(value).toEqual(await file.json());
}

const send = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    body: body === undefined ? null : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    method,
  });
  expect(res.status).toBe(200);
  return res.json();
};

const T = Date.parse("2026-10-14T10:00:00Z");
const iso = (s: number) => new Date(T + s * 1000).toISOString();
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LIVE = id(1);
const RETIRED = id(2);
const JOB = id(3);
const PERSON = id(4);
const GONE = id(5);
const OWNER = id(12);

// A completed job of two turns, with a fixed id.
function job(jobId: string) {
  env.db
    .insert(transcriptionJobs)
    .values({
      admittedAt: new Date(T),
      audioSha256: sha256Hex(jobId),
      billableSeconds: 60,
      id: jobId,
      preparedDurationSeconds: 60,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: jobId,
      state: "completed",
    })
    .run();
  env.db
    .insert(transcripts)
    .values({
      createdAt: new Date(T),
      jobId,
      languageCode: "eng",
      parsed: {
        languageCode: "eng",
        languageProbability: 1,
        turns: [
          {
            end: 4,
            speakerId: "speaker_0",
            start: 0,
            text: "Remember the plumber.",
          },
          { end: 9, speakerId: "speaker_1", start: 5, text: "Monday at nine." },
        ],
        // The first turn's words, timed.
        words: ["Remember", "the", "plumber."].map((text, i) => ({
          end: i + 0.8,
          logprob: null,
          spacing: i === 0 ? "" : " ",
          speakerId: "speaker_0",
          start: i,
          text,
        })),
      },
      parserVersion: PARSER_VERSION,
      raw: {},
    })
    .run();
}

// Every field of every row the phone keeps is set, so a type the phone decodes wrong fails Kit's
// `WireTests` (the Mac's live state, `dictatingSince` and `llm`, needs its socket).
test("GET /changes: a page with each kind and every field, a retired conversation and a removed row", async () => {
  job(JOB);
  mapJob(env.db, JOB, [[T, T + 60_000]]);
  env.db
    .insert(conversations)
    .values([
      {
        captureEndedAt: new Date(iso(60)),
        captureStartedAt: new Date(T),
        closedAt: new Date(iso(400)),
        id: LIVE,
        ownerTitle: "The plumber",
        ownerTitleAt: new Date(iso(300)),
        state: "summarized",
      },
      {
        captureEndedAt: new Date(iso(200)),
        captureStartedAt: new Date(iso(120)),
        id: RETIRED,
      },
    ])
    .run();
  env.db.transaction((tx) => {
    tx.update(conversations)
      .set({ retiredAt: new Date(T + 300_000), successorId: LIVE })
      .where(eq(conversations.id, RETIRED))
      .run();
    tx.update(transcriptionJobs)
      .set({ pages: [[1200, 1290]], sourceId: "dev1" })
      .where(eq(transcriptionJobs.id, JOB))
      .run();
    tx.insert(people)
      .values([
        { aliases: ["Mari"], id: PERSON, name: "Marie-Jo" },
        { id: OWNER, isOwner: true, name: "Dave" },
      ])
      .run();
    tx.insert(speakerAssignments)
      .values(
        [
          { personId: OWNER, speakerLabel: "speaker_0" },
          { personId: PERSON, speakerLabel: "speaker_1" },
        ].map((a) => ({
          ...a,
          jobId: JOB,
          source: "owner" as const,
          status: "person" as const,
          updatedAt: new Date(T + 100_000),
        }))
      )
      .run();
    // A summary run: the title, the TLDR and an unsure split at the second turn.
    tx.insert(intelligenceRuns)
      .values({
        conversationId: LIVE,
        id: id(15),
        model: "claude-sonnet-5-5",
        promptVersion: PROMPT_VERSION,
        provider: "claude-code",
        result: {
          ...storedResult(0, 1),
          boundarySuggestions: [
            {
              confidence: "medium",
              evidenceTurnIds: [1],
              kind: "split_at_turn",
              reason: "call",
              turnId: 1,
            },
          ],
        },
        state: "valid",
        turns: [0, 1].map((turnIndex) => ({
          capturedAt: iso(turnIndex * 5),
          jobId: JOB,
          turnIndex,
        })),
      })
      .run();
    tx.insert(chapters)
      .values({
        conversationId: LIVE,
        endAt: new Date(T + 60_000),
        id: id(6),
        startAt: new Date(T),
        summary: "The plumber comes Monday.",
        title: "Plumber",
      })
      .run();
    logChange(tx, "conversation", [LIVE, RETIRED]);
    logChange(tx, "job", JOB);
    logChange(tx, "person", [PERSON, OWNER, GONE]);
    logChange(tx, "assignment", JOB);
    logChange(tx, "chapter", id(6));
    // A speech fragment withdrawn from page 200 (cutter.ts `withdrawRows`).
    logChange(tx, "withdrawn", `${id(9)}:200:pendant-1`);
  });
  addQuietRange(env.db, {
    endedAt: iso(50),
    id: id(7),
    source: "com.apple.dictation",
    startedAt: iso(45),
  });
  await send("POST", "/edits", {
    at: iso(20),
    editedAt: iso(400),
    id: id(8),
    kind: "split",
  });
  // A merge taken back: its row carries both ends and when it was undone.
  await send("POST", "/edits", {
    editedAt: iso(410),
    from: iso(30),
    id: id(13),
    kind: "merge",
    to: iso(150),
  });
  await send("POST", "/edits", {
    edit: id(13),
    editedAt: iso(420),
    id: id(14),
    kind: "undo",
  });
  storeHistory(env.db, {
    fixes: [
      {
        accuracyM: 8,
        latitude: 21.0,
        longitude: 105.8,
        observedAt: iso(30),
        placeName: "Bakery, Oakridge 31",
      },
    ],
    visits: [],
  });
  storeMacHeard(env.db, new Date(iso(500)));
  storeSubscriptionUsage(env.db, {
    engine: "codex",
    reading: {
      fiveHour: { resetsAt: 1_800_010_000, usedPercent: 0 },
      observedAt: 1_750_000_000,
      sevenDay: { resetsAt: 1_800_600_000, usedPercent: 42.5 },
    },
    type: "subscription.usage",
  });
  await send("PUT", "/vocabulary", { terms: ["Oakridge"] });
  // Set last: the routes above recompute it (conversation-state.ts).
  env.db
    .update(conversations)
    .set({ waitingReason: "macAway", waitingSince: new Date(iso(70)) })
    .where(eq(conversations.id, LIVE))
    .run();

  const page = await send("GET", "/changes?since=0");
  expect(page.removed).toEqual([
    { firstPage: 200, kind: "job", ref: id(9), sourceId: "pendant-1" },
    { kind: "person", ref: GONE },
  ]);
  await expectWire("changes", page);
});

test("PUT /sources/{id}/speech and GET /sources/{id}/blocks", async () => {
  // An old job the cutover gave pages to, on a handed-over source.
  const old = id(101);
  job(old);
  env.db
    .insert(sources)
    .values({ handedOverAt: new Date(T), id: "pendant-1" })
    .run();
  env.db
    .update(transcriptionJobs)
    .set({
      map: {
        segments: [
          [1_790_000_000_000, 1_790_000_020_000],
          [1_790_000_040_000, 1_790_000_060_000],
        ],
        separatorMs: 400,
      },
      pages: [
        [0, 19],
        [40, 59],
      ],
      sourceId: "pendant-1",
    })
    .where(eq(transcriptionJobs.id, old))
    .run();

  const audio = oggOpus(30);
  const form = new FormData();
  form.append("audio", new File([audio], "a.ogg"));
  form.append(
    "metadata",
    JSON.stringify({
      audioSha256: sha256Hex(audio),
      durationSeconds: 30,
      // Its trailing separator fits in the audio.
      map: { segments: [[T, T + 29_000]], separatorMs: 400 },
      pages: [
        [200, 210],
        [213, 220],
      ],
    })
  );
  const put = await app.request("/sources/pendant-1/speech/200", {
    body: form,
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    method: "PUT",
  });
  expect(put.status).toBe(200);
  const answer = await put.json();
  // The new fragment's id is the database's: a fixed one stands in for it.
  const fixed = (value: unknown) =>
    JSON.parse(JSON.stringify(value).replaceAll(answer.id, id(9)));
  await expectWire("speech-put", fixed(answer));
  await expectWire(
    "blocks",
    fixed(await send("GET", "/sources/pendant-1/blocks"))
  );
});

// A thin phone's raw pages (the Android app): what it sends, every field set, and the state it reads.
test("PUT /sources/{id}/pages and GET /sources/{id}/ingest", async () => {
  const bytes = new Uint8Array(500).fill(1, 0, 300).fill(2, 300);
  const batch = {
    codec: "limitless",
    pages: [
      { index: 40, length: 300, startMs: 1_792_656_000_000 },
      { index: 41, length: 200, startMs: 1_792_656_001_500 },
    ],
    sha256: sha256Hex(bytes),
  };
  await expectWire("page-batch", batch);
  const form = new FormData();
  form.append("pages", new File([bytes], "pages.bin"));
  form.append("metadata", JSON.stringify(batch));
  const put = await app.request("/sources/pendant-1/pages/40", {
    body: form,
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    method: "PUT",
  });
  expect(put.status).toBe(200);
  const state = await send("GET", "/sources/pendant-1/ingest");
  expect(await put.json()).toEqual(state);
  await expectWire("ingest-state", state);
});

// What the Mac host polls; its app decodes this file. Every field set: a run in flight, one
// waiting, jobs in each state, an open fragment, a heartbeat, a restic snapshot.
test("GET /status/live", async () => {
  const s = services(testConfig("http://localhost:1"), env.db, {
    audio: memoryAudioStore(),
    intelligence: null,
    restic: {
      daily: () => Promise.resolve(false),
      status: () => ({
        lastError: "restic backup: the snapshot is incomplete",
        lastSnapshotAt: iso(600),
      }),
    },
    search: null,
  });
  job(JOB);
  env.db
    .update(transcriptionJobs)
    .set({ completedAt: new Date(iso(90)), objectKey: "blocks/dev1/1-a.ogg" })
    .where(eq(transcriptionJobs.id, JOB))
    .run();
  env.db
    .insert(transcriptionJobs)
    .values(
      (["queued", "submitted"] as const).map((state, n) => ({
        audioSha256: sha256Hex(state),
        billableSeconds: 120,
        id: id(20 + n),
        preparedDurationSeconds: 120,
        requestSentAt: state === "submitted" ? new Date(iso(100)) : null,
        settings: { keyterms: [], languageCode: null, numSpeakers: null },
        settingsHash: state,
        state,
      }))
    )
    .run();
  env.db
    .insert(speechFragments)
    .values({
      audioSha256: sha256Hex("fragment"),
      captureEnd: new Date(iso(130)),
      captureStart: new Date(iso(100)),
      map: { segments: [[T + 100_000, T + 130_000]], separatorMs: 400 },
      objectKey: "fragments/dev1/300-f.ogg",
      pages: [[300, 310]],
      sourceId: "dev1",
    })
    .run();
  env.db
    .insert(conversations)
    .values(
      [LIVE, RETIRED].map((cid, n) => ({
        captureEndedAt: new Date(iso(60 + n * 200)),
        captureStartedAt: new Date(iso(n * 200)),
        id: cid,
        ownerTitle: n === 0 ? "The plumber" : null,
      }))
    )
    .run();
  env.db
    .insert(intelligenceRuns)
    .values(
      (
        [
          [LIVE, "running", 16],
          [RETIRED, "valid", 17],
          [RETIRED, "waiting", 18],
        ] as const
      ).map(([conversationId, state, n]) => ({
        conversationId,
        createdAt: new Date(iso(n * 10)),
        id: id(n),
        model: "claude-sonnet-5-5",
        promptVersion: PROMPT_VERSION,
        provider: "claude-code" as const,
        state,
        turns: [],
        updatedAt: new Date(iso(n * 10)),
      }))
    )
    .run();
  storeHeartbeat(env.db, {
    build: {
      appBuild: "1",
      appVersion: "1.0",
      device: "iPhone17,1",
      os: "iOS 27",
    },
    connection: { since: iso(0), state: "ready" },
    id: id(19),
    incidents: [],
    observedAt: iso(500),
    pendant: { batteryPercent: 64, charging: "charging" },
    phone: { lowPowerMode: false },
    reason: "periodic",
    recording: {
      lastKnown: "recording",
      lastKnownAt: iso(490),
      state: "recording",
    },
    sync: "caught_up",
    wakes: { bytes24h: 0, duplicates24h: 0, last24h: 0, pagesSaved24h: 0 },
  });
  env.db
    .update(heartbeats)
    .set({ receivedAt: new Date(iso(501)) })
    .run();
  storeMacHeard(env.db, new Date(iso(500)));
  await s.rolling.drain();
  const res = await createApp(s).request("/status/live", {
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
  });
  expect(res.status).toBe(200);
  await expectWire("status-live", await res.json());
});

test("a replayed answer naming a new person makes one person, and a replayed merge answers the same", async () => {
  job(JOB);
  const request = (method: string, path: string, body: unknown) =>
    app.request(path, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${OWNER_TOKEN}`,
        "Content-Type": "application/json",
      },
      method,
    });
  // The phone chose the new person's id: a replay finds the person made the first time.
  const answer = async (personId: string) => {
    const res = await request("PUT", `/transcripts/${JOB}/speakers/speaker_0`, {
      target: { id: personId, kind: "new", name: "Hugo" },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { personId: string | null }[]).map(
      (a) => a.personId
    );
  };
  expect(await answer(id(10))).toEqual(await answer(id(10)));
  expect(countRows(env.db, people)).toBe(1);
  await answer(id(11));
  expect(countRows(env.db, people)).toBe(2);
  // A merge sent again after it succeeded: the same person, 200.
  const merge = () =>
    request("POST", `/people/${id(10)}/merge`, { personId: id(11) });
  const merged = await merge();
  const replayed = await merge();
  expect([merged.status, replayed.status]).toEqual([200, 200]);
  expect(await replayed.json()).toEqual(await merged.json());
  expect(countRows(env.db, people)).toBe(1);
});
