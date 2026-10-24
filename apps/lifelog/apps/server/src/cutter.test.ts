import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  conversations,
  events,
  quietRanges,
  sources,
  speechFragments,
  transcriptionJobs,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { joinOggOpus, oggOpusSeconds } from "./audio";
import { memoryAudioStore } from "./audio-store";
import { sha256Hex } from "./config";
import { admit, blockFrom, cut, QUIET_RANGES_FROM, type Span } from "./cutter";
import type { Job } from "./jobs";
import { services } from "./services";
import { fakeElevenLabs, OWNER_TOKEN, testConfig, testDb } from "./testing";

const fake = fakeElevenLabs();
let env: Awaited<ReturnType<typeof testDb>>;
beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
  fake.server.stop(true);
});
beforeEach(() => {
  env.reset();
  fake.calls.length = 0;
  fake.respond = () =>
    Response.json(
      {
        message: "ok",
        request_id: `req_${randomUUID()}`,
        transcription_id: `tr_${randomUUID()}`,
      },
      { status: 202 }
    );
});

const SOURCE = "pendant-1";
const auth = { Authorization: `Bearer ${OWNER_TOKEN}` };
const appWith = () => {
  const bucket = memoryAudioStore();
  const s = services(
    testConfig(`http://localhost:${fake.server.port}`),
    env.db,
    { audio: bucket }
  );
  return Object.assign(createApp(s), { audio: bucket, s });
};
type App = ReturnType<typeof appWith>;

// fixtures/fragments: a, then b and c moved 30 s earlier, so the three are one block with pauses
// of 6.5 and 8 s between them (their audio, and so `starts`, doesn't depend on where they sit).
const dir = new URL("../../../fixtures/fragments/", import.meta.url);
const fixture = await Bun.file(new URL("fragments.json", dir)).json();
const SHIFT = [0, -30_000, -30_000];
interface Piece {
  audio: Uint8Array<ArrayBuffer>;
  map: { segments: [number, number][]; separatorMs: number };
  pages: [number, number][];
}
const [a, b, c] = (await Promise.all(
  fixture.fragments.map(
    async (f: { file: string; segments: [number, number][] }, i: number) => ({
      audio: await Bun.file(new URL(f.file, dir)).bytes(),
      map: {
        segments: f.segments.map(([from, to]) => [
          from + (SHIFT[i] ?? 0),
          to + (SHIFT[i] ?? 0),
        ]),
        separatorMs: fixture.separatorMs,
      },
      pages: [[1 + 10 * i, 10 + 10 * i]],
    })
  )
)) as [Piece, Piece, Piece];
const lastEnd = (p: Piece) => p.map.segments.at(-1)?.[1] ?? 0;

function putFragment(
  app: App,
  piece: Piece,
  pages = piece.pages,
  durationSeconds = oggOpusSeconds(piece.audio)
) {
  const form = new FormData();
  form.append("audio", new File([piece.audio], "f.ogg"));
  form.append(
    "metadata",
    JSON.stringify({
      audioSha256: sha256Hex(piece.audio),
      durationSeconds,
      map: piece.map,
      pages,
    })
  );
  return app.request(`/sources/${SOURCE}/speech/${pages[0]?.[0]}`, {
    body: form,
    headers: auth,
    method: "PUT",
  });
}

// The phone's word: everything heard through `at`, and sent through `sent` (all of it by default).
const report = (app: App, at: number, sent = at) =>
  app.request(`/sources/${SOURCE}/timeline`, {
    body: JSON.stringify({
      heardThrough: new Date(at).toISOString(),
      sentThrough: new Date(sent).toISOString(),
      spans: [],
    }),
    headers: { ...auth, "Content-Type": "application/json" },
    method: "PUT",
  });

// The same, written straight to the source: no worker runs.
const heard = (at: number) =>
  env.db
    .insert(sources)
    .values({
      heardThrough: new Date(at),
      id: SOURCE,
      sentThrough: new Date(at),
    })
    .onConflictDoUpdate({
      set: { heardThrough: new Date(at), sentThrough: new Date(at) },
      target: sources.id,
    })
    .run();

const jobs = () => env.db.select().from(transcriptionJobs).all();
const fragments = () => env.db.select().from(speechFragments).all();
const uploads = () =>
  fake.calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/speech-to-text")
  );
// What the server holds of the source: each block's id and pages (`GET …/blocks`).
const held = async (app: App): Promise<unknown> =>
  (
    await (
      await app.request(`/sources/${SOURCE}/blocks`, { headers: auth })
    ).json()
  ).blocks.map((x: { jobId: string; pages: unknown }) => [x.jobId, x.pages]);
// What the bucket holds, by key.
const stored = (app: App): unknown[] => [...app.audio.objects.keys()];
const sentAudio = (): Promise<unknown> => {
  const file = uploads().at(-1)?.form?.get("file");
  return file instanceof Blob ? file.bytes() : Promise.resolve(null);
};

// A fragment of `kept` seconds from `start` (s), ending at `end` when given.
const span = (start: number, kept: number, end = start + kept): Span => ({
  end: end * 1000,
  kept: kept * 1000,
  start: start * 1000,
});

// The first block of `open`: its last fragment, or when the server's clock may close it.
const firstBlock = (
  open: Span[],
  sent: number | null,
  heardAt: number | null,
  now: number
) => blockFrom(open, 0, sent, heardAt, now);

test("close rules: a pause the phone saw closes a block of a minute at 5 s, any block at 30 s", () => {
  const now = 10_000_000;
  // 70 s of speech, then the phone sent through 6 s later: closed. 40 s waits for 30 s.
  expect(firstBlock([span(0, 70)], 76_000, 90_000, now)).toMatchObject({
    last: 0,
    onSilence: false,
  });
  expect(firstBlock([span(0, 40)], 46_000, 90_000, now).last).toBeNull();
  // 30 s sent with nothing kept: closed on silence, which the job carries (`endedOnSilence`).
  expect(firstBlock([span(0, 40)], 70_000, 90_000, now)).toMatchObject({
    last: 0,
    onSilence: true,
  });
  // Between fragments the next one shows the pause: 70 s, 6 s, then more.
  expect(
    firstBlock([span(0, 70), span(76, 10)], 86_000, 90_000, now).last
  ).toBe(0);
  // Read on what the phone sent, never under talk it hasn't sent yet.
  expect(firstBlock([span(0, 70)], 71_000, 90_000, now).last).toBeNull();
  // A late fragment, long before the talk going on, closes on its own at once.
  const late = [span(0, 10), span(5000, 10)];
  expect(firstBlock(late, 5_010_000, 5_020_000, 5_015_000).last).toBe(0);
});

test("close rules: the server's clock closes 30 s after the last speech once the phone had nothing left", () => {
  const end = 40_000;
  // Nothing left on the phone (sent reached heard-through): 30 s later by the server's clock.
  expect(firstBlock([span(0, 40)], end, end, end + 29_000)).toEqual({
    last: null,
    onSilence: false,
    wakeAt: end + 30_000,
  });
  expect(firstBlock([span(0, 40)], end, end, end + 30_000).last).toBe(0);
  // Speech the phone hasn't sent yet: no clock, the phone's next word decides.
  expect(firstBlock([span(0, 40)], end, end + 5000, end + 60_000)).toEqual({
    last: null,
    onSilence: false,
    wakeAt: null,
  });
  // Talk resumed 30 s or more later: it starts the next block.
  const resumed = [span(0, 40), span(75, 5)];
  expect(firstBlock(resumed, 80_000, 80_000, 90_000).last).toBe(0);
  // Nothing said by the phone yet: only the cap.
  expect(firstBlock([span(0, 40)], null, null, end + 60_000).last).toBeNull();
});

test("close rules: 2 minutes cap a block at its widest gap after 1.5; a seam only without a pause", () => {
  const now = 10_000_000;
  // 50 + 50 s, a 4 s pause, 10 s, a seam (gap 0), 20 s: the pause, past 1.5 min, wins.
  const talk = [span(0, 50), span(50, 50), span(104, 10), span(114, 20)];
  expect(firstBlock(talk, 120_000, 200_000, now).last).toBe(1);
  // Talk with no pause: cut at the first seam past 1.5 minutes.
  const seams = [span(0, 60), span(60, 40), span(100, 40)];
  expect(firstBlock(seams, 130_000, 200_000, now).last).toBe(1);
  // One fragment over 2 minutes is a block of its own; the cap says nothing of what followed.
  expect(firstBlock([span(0, 130)], 130_000, 200_000, now)).toMatchObject({
    last: 0,
    onSilence: false,
  });
});

test("fragments close into one job: joined exactly, the map's starts from packets, the fragments' audio gone", async () => {
  const app = appWith();
  for (const piece of [a, b, c]) {
    // biome-ignore lint/performance/noAwaitInLoops: in order
    expect((await putFragment(app, piece)).status).toBe(200);
  }
  await app.s.worker.work();
  expect(jobs()).toHaveLength(0);
  expect(app.audio.objects.size).toBe(3);

  // The phone saw 50 s of quiet after c: the block closes, joined and sent.
  expect((await report(app, lastEnd(c) + 50_000)).status).toBe(200);
  await app.s.worker.work();
  const made = jobs();
  expect(made).toHaveLength(1);
  const [
    {
      endedOnSilence,
      id,
      map,
      objectKey,
      pages,
      preparedDurationSeconds,
      state,
    },
  ] = made as [Job];
  expect({
    endedOnSilence,
    map,
    pages,
    preparedDurationSeconds,
    state,
  }).toEqual({
    endedOnSilence: true,
    map: {
      segments: [a, b, c].flatMap((p) => p.map.segments),
      separatorMs: 400,
      starts: fixture.joined.starts,
    },
    pages: [[1, 30]],
    preparedDurationSeconds: fixture.joined.seconds,
    state: "submitted",
  });
  // The joined file is the fixture's, stored as a block's, and it is what ElevenLabs got.
  const joined = await Bun.file(new URL("joined.ogg", dir)).bytes();
  expect(joinOggOpus([a, b, c])).toMatchObject({ audio: joined });
  expect(objectKey).toStartWith(`blocks/${SOURCE}/1-`);
  expect(stored(app)).toEqual([objectKey]);
  expect(await sentAudio()).toEqual(joined);
  expect(fragments().map((f) => [f.jobId, f.objectKey])).toEqual([
    [id, null],
    [id, null],
    [id, null],
  ]);
});

test("paid once: a page is in one fragment and one job", async () => {
  const app = appWith();
  const fragment = await (await putFragment(app, a)).json();
  const { writes } = app.audio;

  // A fragment over a job's pages (a failed one's too), or another fragment's, is refused: nothing
  // kept.
  const [job] = env.db
    .insert(transcriptionJobs)
    .values({
      audioSha256: randomUUID(),
      billableSeconds: 1,
      pages: [[31, 40]],
      preparedDurationSeconds: 1,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: randomUUID(),
      sourceId: SOURCE,
      state: "failed",
    })
    .returning()
    .all();
  for (const pages of [[[35, 40]], [[8, 12]]] as [number, number][][]) {
    // biome-ignore lint/performance/noAwaitInLoops: one after the other
    const answer = await putFragment(app, c, pages);
    expect(answer.status).toBe(409);
    expect((await answer.json()).error).toBe("held");
  }
  expect(app.audio.writes).toBe(writes);
  // What the server holds, jobs and open fragments: the phone renders around it.
  expect(await held(app)).toEqual([
    [job?.id, [[31, 40]]],
    [fragment.id, [[1, 10]]],
  ]);
  // A bucket that fails keeps nothing.
  app.audio.down = true;
  expect((await putFragment(app, b)).status).toBe(503);
  app.audio.down = false;
  expect(fragments()).toHaveLength(1);

  // Two cuts at once make one job.
  await putFragment(app, b);
  await putFragment(app, c);
  await report(app, lastEnd(c) + 50_000);
  await Promise.all([
    cut(env.db, app.audio, new Date(), Date.now()),
    cut(env.db, app.audio, new Date(), Date.now()),
  ]);
  const made = jobs().filter((j) => j.map?.starts);
  expect(made).toHaveLength(1);
  const owners = new Set(fragments().map((f) => f.jobId));
  expect([...owners]).toEqual([made[0]?.id ?? ""]);
});

// No two of these pages' ranges share a page.
const disjoint = (all: [number, number][]) =>
  all
    .toSorted(([x], [y]) => x - y)
    .every(
      ([, last], i, sorted) =>
        last < (sorted[i + 1]?.[0] ?? Number.POSITIVE_INFINITY)
    );

test("concurrent admissions never double-book a page", async () => {
  const app = appWith();
  // Fragments over overlapping pages, uploaded at once: the look and the insert are one
  // transaction, so one of each overlapping set is kept and the others are refused.
  const wanted: [number, number][][] = [
    [[1, 10]],
    [[5, 14]],
    [[10, 12]],
    [[8, 20]],
    [[30, 40]],
  ];
  const answers = await Promise.all(
    wanted.map((pages) => putFragment(app, a, pages))
  );
  const statuses = answers.map((r) => r.status);
  expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
  expect(statuses.filter((s) => s === 409).length).toBeGreaterThan(0);
  const kept = fragments();
  expect(kept).toHaveLength(statuses.filter((s) => s === 200).length);
  expect(kept.some((f) => f.pages[0]?.[0] === 30)).toBe(true);
  expect(disjoint(kept.flatMap((f) => f.pages))).toBe(true);

  // Jobs over overlapping pages, admitted at once, and one over a kept fragment's pages: at most
  // one holds each page, the others are refused.
  const admitted = await Promise.allSettled(
    [[[50, 60]], [[55, 65]], [[60, 70]], [[71, 80]], [[35, 36]]].map(
      async (pages) => {
        await Bun.sleep(0);
        return admit(
          env.db,
          {
            audioSha256: randomUUID(),
            endedOnSilence: true,
            map: a.map,
            objectKey: "k",
            pages: pages as [number, number][],
            preparedDurationSeconds: 1,
            settings: { keyterms: [], languageCode: null, numSpeakers: null },
            sourceId: SOURCE,
          },
          []
        );
      }
    )
  );
  const refused = admitted.filter((r) => r.status === "rejected");
  expect(refused.length).toBeGreaterThanOrEqual(2);
  for (const r of refused) {
    expect(String(r.reason)).toContain("held");
  }
  const made = jobs();
  expect(made).toHaveLength(admitted.length - refused.length);
  expect(made.some((j) => j.pages?.[0]?.[0] === 71)).toBe(true);
  expect(
    disjoint([
      ...made.flatMap((j) => j.pages ?? []),
      ...kept.flatMap((f) => f.pages),
    ])
  ).toBe(true);
});

test("a fragment's duration is measured from its Ogg Opus audio, not trusted from the phone", async () => {
  const app = appWith();
  const seconds = oggOpusSeconds(a.audio) ?? 0;
  const notOgg = { ...a, audio: new Uint8Array(64) };
  for (const [piece, declared] of [
    [a, seconds + 2],
    [notOgg, 1],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one after the other
    const refused = await putFragment(app, piece, piece.pages, declared);
    expect([refused.status, (await refused.json()).error]).toEqual([
      400,
      "invalid_audio",
    ]);
  }
  // A rounding difference is tolerated.
  expect((await putFragment(app, a, a.pages, seconds + 0.4)).status).toBe(200);
});

test("a fragment sent again is the same fragment, before and after its block closed, and buys nothing", async () => {
  const app = appWith();
  const first = await (await putFragment(app, c)).json();
  const again = await (await putFragment(app, c)).json();
  expect(again).toEqual(first);
  expect(first).toMatchObject({ jobId: null, pages: [[21, 30]] });
  expect(app.audio.writes).toBe(1);

  await report(app, lastEnd(c) + 50_000);
  await app.s.worker.work();
  const [job] = jobs();
  const replay = await putFragment(app, c);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ...first, jobId: job?.id });
  await app.s.worker.work();
  expect(jobs()).toHaveLength(1);
  expect(uploads()).toHaveLength(1);
  expect(app.audio.writes).toBe(2);
});

test("audio from before the Mac's quiet ranges is covered: kept without audio, its pages held, never cut", async () => {
  const app = appWith();
  const old = {
    ...a,
    map: {
      ...a.map,
      segments: a.map.segments.map(([from, to]): [number, number] => [
        from - lastEnd(a) + QUIET_RANGES_FROM - 60_000,
        to - lastEnd(a) + QUIET_RANGES_FROM - 60_000,
      ]),
    },
  };
  expect((await putFragment(app, old)).status).toBe(200);
  await report(app, lastEnd(c) + 50_000);
  await app.s.worker.work();
  expect(jobs()).toHaveLength(0);
  expect(stored(app)).toEqual([]);
  expect(fragments().map((f) => [f.jobId, f.objectKey])).toEqual([
    [null, null],
  ]);
  expect((await putFragment(app, a, [[5, 6]])).status).toBe(409);
});

test("a fragment bought while its block was open is covered alone; the others become one job", async () => {
  const app = appWith();
  // d: a's audio as one 2.9 s stretch 10 s after c, pages 31 to 40, in the same block.
  const d: Piece = {
    ...a,
    map: {
      ...a.map,
      segments: [[lastEnd(c) + 10_000, lastEnd(c) + 12_900]],
    },
    pages: [[31, 40]],
  };
  for (const piece of [a, b, c, d]) {
    // biome-ignore lint/performance/noAwaitInLoops: in order
    await putFragment(app, piece);
  }
  await app.s.worker.work.idle();
  // Meanwhile another job, over d's audio only, went to ElevenLabs.
  const [elsewhere] = env.db
    .insert(transcriptionJobs)
    .values({
      audioSha256: randomUUID(),
      billableSeconds: 1,
      captureEnd: new Date(lastEnd(d)),
      captureStart: new Date(d.map.segments[0]?.[0] ?? 0),
      map: d.map,
      preparedDurationSeconds: 1,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: randomUUID(),
      sourceId: SOURCE,
      state: "submitted",
    })
    .returning()
    .all();
  heard(lastEnd(d) + 50_000);
  await cut(env.db, app.audio, new Date(), Date.now());
  const made = jobs().filter((j) => j.id !== elsewhere?.id);
  expect(made.map((j) => [j.pages, j.map?.starts])).toEqual([
    [[[1, 30]], fixture.joined.starts],
  ]);
  const dRow = fragments().find((f) => f.pages[0]?.[0] === 31);
  expect([dRow?.jobId, dRow?.objectKey]).toEqual([null, null]);
  expect(stored(app)).toEqual([made[0]?.objectKey]);
});

test("the Mac's gate reads the block's latest end, not its last fragment's", async () => {
  const app = appWith();
  // x starts first and ends last: its second stretch is a minute and a half after its first.
  const [one, two] = a.map.segments;
  const x: Piece = {
    ...a,
    map: {
      ...a.map,
      segments: [
        one ?? [0, 0],
        [(two?.[0] ?? 0) + 90_000, (two?.[1] ?? 0) + 90_000],
      ],
    },
  };
  await putFragment(app, x);
  await putFragment(app, b);
  await app.s.worker.work.idle();
  heard(lastEnd(x) + 50_000);
  await cut(env.db, app.audio, new Date(lastEnd(b) + 1000), Date.now());
  expect(jobs()).toHaveLength(0);
  await cut(env.db, app.audio, new Date(lastEnd(x)), Date.now());
  expect(jobs()).toHaveLength(1);
});

test("a block that fails is recorded, the next one still closes, and its third failure withdraws it", async () => {
  const app = appWith();
  await putFragment(app, c);
  await app.s.worker.work.idle();
  // A fragment whose audio no longer reads as Ogg, a minute before c.
  const shift = (at: number) => at - 60_000;
  env.db
    .insert(speechFragments)
    .values({
      ...a,
      audioSha256: randomUUID(),
      captureEnd: new Date(shift(lastEnd(c))),
      captureStart: new Date(shift(lastEnd(c)) - 1000),
      map: {
        segments: [[shift(lastEnd(c)) - 1000, shift(lastEnd(c))]],
        separatorMs: 400,
      },
      objectKey: "fragments/broken.ogg",
      pages: [[1, 10]],
      sourceId: SOURCE,
    })
    .run();
  await app.audio.put("fragments/broken.ogg", new Uint8Array(64));
  heard(lastEnd(c) + 50_000);
  await cut(env.db, app.audio, new Date(), Date.now());
  expect(jobs().map((j) => j.pages)).toEqual([[[21, 30]]]);
  const failed = env.db
    .select()
    .from(events)
    .where(eq(events.name, "block.failed"))
    .all();
  expect(failed).toHaveLength(1);
  // Tried on each run; the third failure withdraws it, and the phone sends its pages again.
  await cut(env.db, app.audio, new Date(), Date.now());
  await cut(env.db, app.audio, new Date(), Date.now());
  expect(fragments().map((f) => f.pages)).toEqual([[[21, 30]]]);
  const feed = await (
    await app.request("/changes?since=0", { headers: auth })
  ).json();
  expect(feed.removed).toContainEqual(
    expect.objectContaining({ firstPage: 1, kind: "job" })
  );
});

test("dictation: a block waits for the Mac; a fragment a quiet range touches is withdrawn, never sent, and the rest goes", async () => {
  const app = appWith();
  for (const piece of [a, b, c]) {
    // biome-ignore lint/performance/noAwaitInLoops: in order
    await putFragment(app, piece);
  }
  await app.s.worker.work.idle();
  heard(lastEnd(c) + 50_000);

  // The Mac hasn't vouched past the block's end: nothing closes, nothing is read.
  expect(
    await cut(env.db, app.audio, new Date(lastEnd(c) - 1), Date.now())
  ).toBeNull();
  expect(jobs()).toHaveLength(0);

  // The owner dictated inside b.
  const [from = 0] = b.map.segments[0] ?? [];
  env.db
    .insert(quietRanges)
    .values({
      endedAt: new Date(from + 500),
      id: randomUUID(),
      source: "com.apple.dictation",
      startedAt: new Date(from + 100),
    })
    .run();
  const bId = fragments().find((f) => f.pages[0]?.[0] === 11)?.id;
  await app.s.worker.work();
  const [job, ...more] = jobs();
  expect(more).toHaveLength(0);
  expect(job?.pages).toEqual([
    [1, 10],
    [21, 30],
  ]);
  expect(await sentAudio()).toEqual(joinOggOpus([a, c])?.audio);
  expect(uploads()).toHaveLength(1);
  expect(fragments().map((f) => f.id)).not.toContain(bId);
  expect(stored(app)).toEqual([job?.objectKey]);
  const feed = await (
    await app.request("/changes?since=0", { headers: auth })
  ).json();
  // Removed with its first page: the phone sends its pages again with no memory of its id.
  const removed = { firstPage: 11, kind: "job", ref: bId, sourceId: SOURCE };
  expect(feed.removed).toContainEqual(removed);
  // Its pages are free again: the phone sends them without the range.
  expect(await held(app)).toEqual([
    [
      job?.id,
      [
        [1, 10],
        [21, 30],
      ],
    ],
  ]);
});

test("a range that comes after the block closed withdraws its job in the worker, with its fragments", async () => {
  const app = appWith();
  await putFragment(app, a);
  await app.s.worker.work.idle();
  heard(lastEnd(a) + 50_000);
  // Closed, not sent yet; then the phone's playback range lands over it.
  await cut(env.db, app.audio, new Date(), Date.now());
  const [job] = jobs();
  const [fragment] = fragments();
  const [from = 0] = a.map.segments[0] ?? [];
  env.db
    .insert(quietRanges)
    .values({
      endedAt: new Date(from + 500),
      id: randomUUID(),
      source: "playback",
      startedAt: new Date(from + 100),
    })
    .run();
  await app.s.worker.work();
  expect(uploads()).toHaveLength(0);
  expect(jobs()).toHaveLength(0);
  expect(fragments()).toHaveLength(0);
  expect(app.audio.objects.size).toBe(0);
  const feed = await (
    await app.request("/changes?since=0", { headers: auth })
  ).json();
  const withdrawn = { firstPage: 1, kind: "job", sourceId: SOURCE };
  expect(feed.removed).toContainEqual({ ...withdrawn, ref: job?.id });
  expect(feed.removed).toContainEqual({ ...withdrawn, ref: fragment?.id });
});

test("an open fragment counts as uploaded for its conversation", async () => {
  const app = appWith();
  const id = randomUUID();
  env.db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(lastEnd(a) + 1000),
      captureStartedAt: new Date((a.map.segments[0]?.[0] ?? 0) - 1000),
      id,
      sourceId: SOURCE,
    })
    .run();
  await putFragment(app, a);
  app.s.states.refresh();
  const [row] = env.db
    .select({ state: conversations.state })
    .from(conversations)
    .where(eq(conversations.id, id))
    .all();
  expect(row?.state).toBe("uploaded");
});
