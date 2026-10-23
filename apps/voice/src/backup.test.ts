import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { countRows } from "@lifelog/db";
import { backupFiles, transcriptionJobs } from "@lifelog/db/schema";
import { Glob } from "bun";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { memoryAudioStore } from "./audio-store";
import { backupStatus, snapshotArchive } from "./backup";
import { sha256Hex } from "./config";
import { services } from "./services";
import { OWNER_TOKEN, oggOpus, testConfig, testDb } from "./testing";

let env: Awaited<ReturnType<typeof testDb>>;
beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
});
beforeEach(() => env.reset());

const auth = { Authorization: `Bearer ${OWNER_TOKEN}` };
const SOURCE = "pendant-1";
const setup = () => {
  const bucket = memoryAudioStore();
  const s = services(testConfig("http://127.0.0.1:1"), env.db, {
    audio: bucket,
  });
  return Object.assign(createApp(s), { bucket });
};
type App = ReturnType<typeof setup>;
const put = (
  app: App,
  path: string,
  bytes: Uint8Array,
  sha = sha256Hex(bytes)
) =>
  app.request(path, {
    body: bytes as BodyInit,
    headers: { ...auth, "X-Content-Sha256": sha },
    method: "PUT",
  });
const pack = (size = 1000) => crypto.getRandomValues(new Uint8Array(size));
const held = async (app: App) =>
  (await app.request(`/backup/${SOURCE}`, { headers: auth })).json();

function completedJob(seconds = 60, objectKey: string | null = null) {
  const data = oggOpus(seconds);
  const [job] = env.db
    .insert(transcriptionJobs)
    .values({
      audioSha256: sha256Hex(data),
      billableSeconds: seconds,
      objectKey,
      preparedDurationSeconds: seconds,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: randomUUID(),
      state: "completed",
    })
    .returning()
    .all();
  return { data, id: job?.id ?? "", sha: sha256Hex(data) };
}

test("a pack is stored once by content, listed, and refused when its hash is wrong", async () => {
  const app = setup();
  const bytes = pack();
  const path = `/backup/packs/${SOURCE}/p0000000010`;
  expect(await (await put(app, path, bytes)).json()).toEqual({ stored: true });
  expect(await (await put(app, path, bytes)).json()).toEqual({ stored: false });
  expect(app.bucket.writes).toBe(1);
  const sha = sha256Hex(bytes);
  expect([...app.bucket.objects.keys()]).toEqual([
    `raw/${SOURCE}/p0000000010-${sha}.pack`,
  ]);
  expect((await held(app)).packs).toEqual([
    { bytes: 1000, name: "p0000000010", sha256: sha },
  ]);

  const wrong = await put(app, `/backup/packs/${SOURCE}/p2`, pack(), sha);
  expect(wrong.status).toBe(400);
  expect(app.bucket.writes).toBe(1);
});

test("a bucket that is down records nothing, and the pack goes in when it is back", async () => {
  const app = setup();
  const bytes = pack();
  app.bucket.down = true;
  const down = await put(app, `/backup/packs/${SOURCE}/p1`, bytes);
  expect(down.status).toBe(503);
  expect(env.db.select().from(backupFiles).all()).toHaveLength(0);
  app.bucket.down = false;
  expect((await put(app, `/backup/packs/${SOURCE}/p1`, bytes)).status).toBe(
    200
  );
  expect((await held(app)).packs).toHaveLength(1);
});

test("source.sqlite keeps one snapshot per date and the last 7 dates", async () => {
  const app = setup();
  const path = `/backup/source-db/${SOURCE}`;
  // Eight older dates, then two uploads today: the second replaces the first.
  for (let day = 1; day <= 8; day += 1) {
    const bytes = pack(200);
    // biome-ignore lint/performance/noAwaitInLoops: one snapshot per day, in order
    await put(app, path, bytes);
    env.db
      .update(backupFiles)
      .set({ name: `2026-09-0${day}` })
      .where(eq(backupFiles.sha256, sha256Hex(bytes)))
      .run();
  }
  const first = pack(300);
  const second = pack(400);
  await put(app, path, first);
  await put(app, path, second);
  const rows = env.db.select().from(backupFiles).all();
  expect(rows.map((r) => r.name).sort()).toEqual([
    "2026-09-03",
    "2026-09-04",
    "2026-09-05",
    "2026-09-06",
    "2026-09-07",
    "2026-09-08",
    rows.find((r) => r.sha256 === sha256Hex(second))?.name ?? "",
  ]);
  expect(app.bucket.objects.size).toBe(7);
  const { latestSnapshot } = await held(app);
  expect(latestSnapshot.sha256).toBe(sha256Hex(second));
  expect(latestSnapshot.bytes).toBe(400);
  // The same bytes again change nothing.
  expect(await (await put(app, path, second)).json()).toEqual({
    stored: false,
  });

  // A delete that fails still keeps the new snapshot; the dropped one's object leaks.
  app.bucket.delete = () => Promise.reject(new Error("bucket unreachable"));
  const third = pack(500);
  expect((await put(app, path, third)).status).toBe(200);
  expect(countRows(env.db, backupFiles)).toBe(7);
  expect(app.bucket.objects.size).toBe(8);
});

test("a completed job takes its audio back: sha and duration checked, stored once, nothing admitted", async () => {
  const app = setup();
  const job = completedJob();
  const path = `/jobs/${job.id}/audio`;
  const stored = await put(app, path, job.data);
  expect(stored.status).toBe(200);
  expect(await stored.json()).toEqual({
    jobId: job.id,
    objectKey: `jobs/${job.sha}.ogg`,
  });
  expect(app.bucket.objects.has(`jobs/${job.sha}.ogg`)).toBe(true);
  expect((await put(app, path, job.data)).status).toBe(200);
  expect(app.bucket.writes).toBe(1);

  // Not this job's audio; a job with a key keeps its own key; unknown and unfinished jobs.
  expect((await put(app, path, oggOpus(60))).status).toBe(409);
  const keyed = completedJob(30, "blocks/pendant-1/0-x.ogg");
  await put(app, `/jobs/${keyed.id}/audio`, keyed.data);
  expect(app.bucket.objects.has("blocks/pendant-1/0-x.ogg")).toBe(true);
  expect((await put(app, `/jobs/${randomUUID()}/audio`, job.data)).status).toBe(
    404
  );
  env.db
    .update(transcriptionJobs)
    .set({ state: "queued" })
    .where(eq(transcriptionJobs.id, keyed.id))
    .run();
  expect((await put(app, `/jobs/${keyed.id}/audio`, keyed.data)).status).toBe(
    409
  );
  // The right sha, the wrong length.
  const short = completedJob(60);
  env.db
    .update(transcriptionJobs)
    .set({ preparedDurationSeconds: 90 })
    .where(eq(transcriptionJobs.id, short.id))
    .run();
  expect((await put(app, `/jobs/${short.id}/audio`, short.data)).status).toBe(
    400
  );

  const jobs = env.db.select().from(transcriptionJobs).all();
  expect(jobs.filter((j) => j.state === "queued")).toHaveLength(1);
});

test("status counts packs, the latest snapshot and jobs with and without bucket audio", async () => {
  const app = setup();
  const job = completedJob();
  completedJob();
  expect(backupStatus(env.db)).toMatchObject({
    jobsWithAudio: 0,
    jobsWithoutAudio: 2,
    latestSnapshotAt: null,
    packBytes: 0,
    packs: 0,
  });
  await put(app, `/jobs/${job.id}/audio`, job.data);
  await put(app, `/backup/packs/${SOURCE}/p1`, pack(500));
  await put(app, `/backup/packs/${SOURCE}/p2`, pack(700));
  await put(app, `/backup/source-db/${SOURCE}`, pack(100));
  const status = backupStatus(env.db);
  expect(status).toMatchObject({
    jobsWithAudio: 1,
    jobsWithoutAudio: 1,
    packBytes: 1200,
    packs: 2,
  });
  expect(status.latestSnapshotAt).not.toBeNull();
});

test("only backup.ts knows the raw keys, and nothing reads an object back from them", async () => {
  const files = [...new Glob("**/*.ts").scanSync(import.meta.dir)].filter(
    (f) => !f.endsWith(".test.ts")
  );
  const text = new Map(
    await Promise.all(
      files.map(
        async (f) =>
          [f, await Bun.file(`${import.meta.dir}/${f}`).text()] as const
      )
    )
  );
  expect(
    [...text].filter(([, t]) => t.includes("raw/${")).map(([f]) => f)
  ).toEqual(["backup.ts"]);
  // Never an object read back from the store (`audio.get`); database reads are fine.
  expect(text.get("backup.ts")).not.toContain("audio.get(");
});

test("the server's archive is copied once a day, whole and readable, and the last 7 dates kept", async () => {
  const app = setup();
  const day = (d: number) => new Date(Date.UTC(2026, 9, d, 3));
  expect(await snapshotArchive(env.db, app.bucket, day(1))).toBe(true);
  expect(await snapshotArchive(env.db, app.bucket, day(1))).toBe(false);
  const [key] = [...app.bucket.objects.keys()].filter((k) =>
    k.startsWith("archive/")
  );
  const bytes = app.bucket.objects.get(key ?? "");
  if (!bytes) {
    throw new Error("no snapshot");
  }
  // A whole database, the copy's own row included.
  const copy = Database.deserialize(bytes);
  expect(copy.query("select name from backup_files").all()).toEqual([]);
  copy.close();
  for (let d = 2; d <= 9; d += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one night after the other
    await snapshotArchive(env.db, app.bucket, day(d));
  }
  const archives = env.db
    .select()
    .from(backupFiles)
    .where(eq(backupFiles.kind, "archive"))
    .all();
  expect(archives.map((a) => a.name).sort()).toEqual(
    [3, 4, 5, 6, 7, 8, 9].map((d) => `2026-10-0${d}`)
  );
  expect(
    [...app.bucket.objects.keys()].filter((k) => k.startsWith("archive/"))
  ).toHaveLength(7);
});
