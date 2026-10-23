import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  conversations as conversationsTable,
  events,
  pagePieces,
  quietRanges,
  rawPages,
  sources,
  speechFragments,
  timelineSpans,
  transcriptionJobs,
} from "@lifelog/db/schema";
import { eq, sql } from "drizzle-orm";
import { oggOpusSeconds } from "./audio";
import { type AudioStore, memoryAudioStore } from "./audio-store";
import { sha256Hex } from "./config";
import { cut, withdrawRows } from "./cutter";
import { markDirty } from "./grouping";
import { label, stopWorker } from "./page-audio";
import { pageLabeler } from "./page-labels";
import { pageProcessor } from "./page-processing";
import { ingestState, storePages } from "./pages";
import { storeTranscript, testDb } from "./testing";
import { loadTurns, startsOf } from "./transcript";
import { rebuildTurns } from "./turns";

// fixtures/pages: made-up Omi records and what Kit's code makes of them (page-rules.test.ts).
const dir = new URL("../../../fixtures/pages/", import.meta.url);
const bin = new Uint8Array(
  await Bun.file(new URL("omi.bin", dir)).arrayBuffer()
);
const expected = await Bun.file(new URL("expected.json", dir)).json();
const [kit] = expected.fragments;
const SOURCE = "omi-pendant";
// The tables a pass must read by index.
const tables =
  /\b(page_pieces|raw_pages|transcription_jobs|speech_fragments)\b/;
const PAGES = bin.length / 444;
const spanEnd = (i: number) => expected.pieces[i].end as number;

let env: ReturnType<typeof testDb>;
beforeEach(() => {
  env = testDb();
});
afterEach(() => {
  env.drop();
});

// A processor over a fresh archive; its clock and the Mac's watermark move with the test.
function setup(batchPages = 3000) {
  const audio = memoryAudioStore();
  const at = { clock: Date.now(), pokes: 0, vouched: Number.POSITIVE_INFINITY };
  const pages = pageProcessor(
    env.db,
    audio,
    {
      poke: () => {
        at.pokes += 1;
      },
    },
    { batchPages, now: () => at.clock, vouched: () => at.vouched }
  );
  return { at, audio, pages };
}

// The fixture's pages [first, last) as one stored batch.
function store(audio: AudioStore, first = 0, last = PAGES, from = bin) {
  const bytes = from.subarray(first * 444, last * 444);
  const metadata = {
    codec: "omi" as const,
    pages: Array.from({ length: last - first }, (_, i) => ({
      index: first + i,
      length: 444,
    })),
    sha256: sha256Hex(bytes),
  };
  return storePages(env.db, audio, SOURCE, first, metadata, bytes);
}

const source = () =>
  env.db.select().from(sources).where(eq(sources.id, SOURCE)).get();
const fragments = () => env.db.select().from(speechFragments).all();
const pieces = () =>
  env.db
    .select()
    .from(pagePieces)
    .orderBy(pagePieces.firstPage)
    .all()
    .map((p) => ({
      end: p.endAt.getTime(),
      first: p.firstPage,
      last: p.lastPage,
      speech: p.speech,
      start: p.startAt.getTime(),
    }));
// A source's timeline spans as Kit's FactsBuilder gives them (expected.json `timeline`).
const ms = (ranges: [string, string][]) =>
  ranges.map(([a, b]) => [Date.parse(a), Date.parse(b)]);
const timeline = () =>
  env.db
    .select()
    .from(timelineSpans)
    .where(eq(timelineSpans.sourceId, SOURCE))
    .orderBy(timelineSpans.firstPage)
    .all()
    .map((s) => ({
      audible: ms(s.facts.audible),
      breaks: s.facts.breaks.map((b) => b.kind),
      end: s.endAt.getTime(),
      firstPage: s.firstPage,
      speech: ms(s.facts.speech),
      start: s.startAt.getTime(),
      unanalyzed: ms(s.facts.unanalyzed),
    }));
const kitPieces = () =>
  expected.pieces.map(
    ({ probabilities: _, ...p }: Record<string, unknown>) => p
  );
const quiet = ([start, end]: [number, number]) =>
  env.db
    .insert(quietRanges)
    .values({
      endedAt: new Date(end),
      id: crypto.randomUUID(),
      source: "mac",
      startedAt: new Date(start),
    })
    .run();

// The one fragment is Kit's: its pages, each stretch narrowed to whole packets, and Ogg Opus as
// long as its map.
async function expectKitFragment(audio: AudioStore) {
  const [fragment] = fragments();
  expect(fragments().map((f) => f.pages)).toEqual([kit.pages]);
  const map = fragment?.map ?? { segments: [], separatorMs: 0 };
  for (const [s, e] of map.segments) {
    expect(
      kit.segments.some(
        ([ks, ke]: [number, number]) =>
          ks <= s && e <= ke && e - s >= ke - ks - 40
      )
    ).toBe(true);
  }
  const bytes =
    (await audio.get(fragment?.objectKey ?? "")) ?? new Uint8Array();
  const [start, end] = map.segments.at(-1) ?? [0, 0];
  expect(oggOpusSeconds(bytes)).toBe(
    ((startsOf(map).at(-1) ?? 0) + end - start) / 1000
  );
}

test("an Omi source's pages are labeled as Kit labels them, and cut into Kit's fragment", async () => {
  const { audio, pages } = setup();
  expect(await store(audio)).toMatchObject({ labeledUntil: null });
  await pages.run();
  expect(pieces()).toEqual(kitPieces());
  expect(timeline()).toEqual(expected.timeline);
  expect(ingestState(env.db, SOURCE).labeledUntil).toBe(
    new Date(spanEnd(1)).toISOString()
  );
  // Kit's quiet range came after the labels: the cut leaves it out.
  quiet(expected.quiet[0]);
  env.db.delete(speechFragments).run();
  env.db.update(sources).set({ pagesCutFrom: 0 }).run();
  await pages.run();
  await expectKitFragment(audio);
  // Heard through the labeled audio less 3 s; the speech after the fragment waits.
  expect(source()?.heardThrough?.getTime()).toBe(expected.heardThrough);
  expect(source()?.sentThrough?.getTime()).toBe(expected.kept.at(-1)[0]);
  expect(source()?.pagesCutFrom).toBe(kit.last + 1);
});

test("batches of 100 pages label as one: a piece goes on across a batch's end", async () => {
  const { audio, pages } = setup(100);
  await store(audio);
  await pages.run();
  expect(pieces()).toEqual(kitPieces());
  expect(timeline()).toEqual(expected.timeline);
});

test("dictation is never decoded: a quiet range known before labeling is silence to Silero", async () => {
  const { audio, pages } = setup();
  await store(audio);
  // Inside the second span's first sentence, which Kit hears as speech.
  const range: [number, number] = [
    expected.pieces[1].start + 2000,
    expected.pieces[1].start + 5000,
  ];
  quiet(range);
  await pages.run();
  const speech = pieces().flatMap((p) => p.speech);
  expect(
    speech.some(([s, e]) => s < range[1] - 1000 && e > range[0] + 1000)
  ).toBe(false);
});

test("only audio the Mac vouched for is labeled", async () => {
  const { at, audio, pages } = setup();
  await store(audio);
  at.vouched = spanEnd(0) + 1000;
  await pages.run();
  expect(ingestState(env.db, SOURCE).labeledUntil).toBe(
    new Date(spanEnd(0)).toISOString()
  );
  at.vouched = Number.POSITIVE_INFINITY;
  await pages.run();
  expect(pieces()).toEqual(kitPieces());
});

test("a late page is labeled on its own, and its speech is cut", async () => {
  const { at, audio, pages } = setup();
  // The second span's first pages, just before its speech, come after labeling went past them.
  await store(audio, 0, 171);
  await store(audio, 181);
  at.clock += 11 * 60_000;
  await pages.run();
  await store(audio, 171, 181);
  await pages.run();
  expect(pieces().some((p) => p.first === 171)).toBe(true);
  const late = env.db
    .select()
    .from(events)
    .where(eq(events.name, "pages.late"))
    .all();
  expect(late.map((e) => e.fields)).toEqual([
    { first: 171, last: 180, source: SOURCE },
  ]);
  expect(
    env.db.select().from(rawPages).where(eq(rawPages.labeled, false)).all()
  ).toEqual([]);
  expect(
    fragments().some((f) => f.pages.some(([a, z]) => a <= 171 && z >= 171))
  ).toBe(true);
  // The late pages are a span of their own; the span after the hole keeps its breaks.
  expect(timeline().map((s) => [s.firstPage, s.breaks])).toEqual([
    [0, []],
    [171, []],
    [181, ["missingPages", "timeGap"]],
  ]);
});

// The fixture's records restamped: whole seconds from `t0`, plus `jump` ms from record `at` on.
function restamped(t0: number, at: number, jump: number) {
  const out = new Uint8Array(bin);
  for (let i = 0; i < PAGES; i += 1) {
    const end = t0 + (i + 1) * 100 + (i >= at ? jump : 0);
    new DataView(out.buffer).setUint32(i * 444, Math.floor(end / 1000));
  }
  return out;
}

test("a span going on after a piece that caught up has no false unanalyzed seam", async () => {
  const { audio, pages } = setup();
  // 25 records end at 2.5 s and the batch is labeled whole; the next records' stamps jump 1.5 s.
  const t0 = expected.pieces[0].start as number;
  const records = restamped(t0, 25, 1500);
  await store(audio, 0, 25, records);
  await pages.run();
  await store(audio, 25, 45, records);
  await pages.run();
  const [span] = timeline();
  expect(timeline()).toHaveLength(1);
  expect(span?.unanalyzed).toEqual([]);
  expect(span?.start).toBe(t0);
});

test("a fragment withdrawn while a pass stores another is cut again", async () => {
  const { at, audio, pages } = setup();
  await store(audio);
  await pages.run();
  const [first] = fragments();
  // Ten quiet minutes later the last speech goes; while it is stored, the first fragment is
  // withdrawn (a quiet range the Mac reported late), which moves the cursor back.
  at.clock += 11 * 60_000;
  const { put } = audio;
  audio.put = async (key, bytes, type) => {
    await put(key, bytes, type);
    if (key.startsWith("fragments/") && first) {
      audio.put = put;
      await withdrawRows(env.db, audio, (tx) => {
        const row = tx
          .delete(speechFragments)
          .where(eq(speechFragments.id, first.id))
          .returning()
          .get();
        return (
          row && {
            ids: [row.id],
            key: row.objectKey,
            pages: row.pages,
            sourceId: SOURCE,
          }
        );
      });
    }
  };
  await pages.run();
  // Its pages are in a fragment again.
  const [[firstPage]] = kit.pages;
  const holders = env.db.all<{ id: string }>(
    sql`select f.id from speech_fragments f, json_each(f.pages) r
      where r.value ->> 0 <= ${firstPage} and r.value ->> 1 >= ${firstPage}`
  );
  expect(holders).toHaveLength(1);
});

test("ten quiet minutes later the rest goes, and a fragment withdrawn at its block's close is cut again without its range", async () => {
  const { at, audio, pages } = setup();
  await store(audio);
  quiet(expected.quiet[0]);
  await pages.run();
  at.clock += 11 * 60_000;
  await pages.run();
  expect(fragments()).toHaveLength(2);
  const late: [number, number] = [
    kit.segments[0][0] + 1000,
    kit.segments[0][0] + 1500,
  ];
  quiet(late);
  await cut(env.db, audio, new Date(at.clock + 3_600_000), at.clock);
  expect(source()?.pagesCutFrom).toBe(kit.pages[0][0]);
  await pages.run();
  expect(fragments().length).toBeGreaterThan(0);
  for (const f of fragments()) {
    expect(f.map.segments.every(([s, e]) => e <= late[0] || s >= late[1])).toBe(
      true
    );
  }
  expect(at.pokes).toBeGreaterThan(0);
});

// A plan step that reads a page, piece, job or fragment table whole, or a source's whole history
// of it: a scan, or a search narrowed by the source alone (but a min or max read off a covering
// index's end).
const wholeHistory = (detail: string) =>
  tables.test(detail) &&
  (detail.startsWith("SCAN") ||
    (detail.endsWith("(source_id=?)") && !detail.includes("COVERING INDEX")));

test("a pass reads the archive by index: no page, piece, job or fragment table is scanned", async () => {
  const { at, audio, pages } = setup();
  await store(audio);
  await pages.run();
  // Every statement a later pass prepares (a fragment's worth of cutting), and its plan.
  const client = env.db.$client;
  const prepare = client.prepare.bind(client);
  const statements = new Set<string>();
  client.prepare = ((query: string) => {
    statements.add(query);
    return prepare(query);
  }) as typeof client.prepare;
  at.clock += 11 * 60_000;
  await pages.run();
  client.prepare = prepare;
  const scans = [...statements]
    .filter((q) => tables.test(q) && !q.startsWith("insert"))
    .flatMap((q) =>
      client
        .prepare(`explain query plan ${q}`)
        .all()
        .map((row) => (row as { detail: string }).detail)
        .filter((detail) => wholeHistory(detail))
        .map((detail) => `${detail} in ${q}`)
    );
  expect(scans).toEqual([]);
});

test("a worker that dies mid-piece loses nothing: the piece is labeled again from its first page", async () => {
  const { audio } = setup();
  await store(audio);
  const labelBatch = pageLabeler(env.db, audio, {
    batchPages: 100,
    now: () => Date.now(),
    vouched: () => Number.POSITIVE_INFINITY,
  });
  // Pages 0 to 99 are an open piece in the worker; then the worker ends.
  expect(await labelBatch(SOURCE)).toBe(true);
  stopWorker();
  await Bun.sleep(50);
  // biome-ignore lint/performance/noAwaitInLoops: batch after batch
  while (await labelBatch(SOURCE)) {
    // the next batch
  }
  expect(pieces()).toEqual(kitPieces());
  expect(
    env.db.select().from(rawPages).where(eq(rawPages.labeled, false)).all()
  ).toEqual([]);
});

test("a call the worker can't answer settles: an exit rejects it, an unknown piece is refused", async () => {
  const request = {
    continues: false,
    end: 60_000,
    final: true,
    packets: [],
    start: 0,
    stream: "exit",
  };
  const pending = label(request);
  await Bun.sleep(5);
  stopWorker();
  await expect(pending).rejects.toThrow("VAD worker");
  await expect(
    label({ ...request, continues: true, stream: "nothing" })
  ).rejects.toThrow("no piece");
  // The chain goes on.
  expect(
    (await label({ ...request, end: 1000 }))?.probabilities
  ).toBeInstanceOf(Float32Array);
});

test("an Omi source's speech becomes a conversation, and its transcript lands in it", async () => {
  const { at, audio, pages } = setup();
  await store(audio);
  await pages.run();
  at.clock += 11 * 60_000;
  await pages.run();
  // Its blocks close by the server's clock; the first job comes back with one turn.
  await cut(env.db, audio, new Date(at.clock + 3_600_000), at.clock);
  const job = env.db
    .select()
    .from(transcriptionJobs)
    .where(eq(transcriptionJobs.sourceId, SOURCE))
    .get();
  if (!job) {
    throw new Error("no job");
  }
  // As jobs.ts `complete` stores it: its words, its turns, its range dirty.
  const word = { logprob: null, speakerId: "speaker_0" };
  storeTranscript(
    env.db,
    job.id,
    [
      {
        end: 2.5,
        speakerId: "speaker_0",
        start: 0.5,
        text: "The quick brown fox.",
      },
    ],
    [
      { ...word, end: 1.2, spacing: "", start: 0.5, text: "The quick" },
      { ...word, end: 2.5, spacing: " ", start: 1.3, text: "brown fox." },
    ]
  );
  rebuildTurns(env.db, job.id);
  markDirty(env.db, [SOURCE], [job.captureStart ?? 0, job.captureEnd ?? 0]);
  await pages.run();
  const conversations = env.db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.sourceId, SOURCE))
    .all();
  expect(conversations.length).toBeGreaterThan(0);
  const words = conversations.flatMap(
    (c) => loadTurns(env.db, c.id)?.turns.map((t) => t.text) ?? []
  );
  expect(words.join(" ")).toContain("brown fox.");
});
