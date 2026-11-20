import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { clock } from "@life/server/src/core/clock";
import { quietRanges } from "@lifelog/db/schema";
import { phoneDictations } from "@lifelog/db/schema/phone-dictations";
import { createApp } from "../app";
import { memoryAudioStore } from "../audio-store";
import { sha256Hex } from "../config";
import { jobWorker } from "../jobs";
import {
  CLOCK_MARGIN_MS,
  DICTATION_CAP_MS,
  openPhoneDictation,
  processingLimit,
  recordSourceClock,
  settlePhoneDictations,
} from "../phone-dictations";
import { services } from "../services";
import { OWNER_TOKEN, testConfig, testDb } from "../testing";

const READ_TOKEN = "read-test-token";
let env: ReturnType<typeof testDb>;
let app: ReturnType<typeof createApp>;
beforeAll(() => {
  env = testDb();
  app = createApp(
    services(
      testConfig("http://localhost:1", {
        READ_TOKEN_HASH: sha256Hex(READ_TOKEN),
      }),
      env.db,
      { intelligence: null, search: null }
    )
  );
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
});

const post = (path: string, body: object, token = OWNER_TOKEN) =>
  app.request(path, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
const iso = (ms: number) => new Date(ms).toISOString();
const opening = (startedAt: number, id = randomUUID()) => ({
  id,
  phoneId: "phone-test",
  source: "app.example.notes",
  startedAt: iso(startedAt),
});
const open = (body: ReturnType<typeof opening>, token?: string) =>
  post("/dictation/ranges", body, token);
const close = (id: string) => post(`/dictation/ranges/${id}/close`, {});
// The Mac vouching for everything: the limit is the phone's alone. A source whose uploader's clock
// is the server's, to the millisecond.
const MAC = { vouchedThrough: () => new Date(8.64e15) };
const SOURCE = "omi-test";
const limit = (sourceId = SOURCE) =>
  processingLimit(env.db, MAC)(sourceId).getTime();
beforeEach(() => {
  recordSourceClock(
    env.db,
    SOURCE,
    { offsetMs: 0, uncertaintyMs: 0 },
    new Date(0)
  );
});
const stored = () =>
  env.db
    .select()
    .from(quietRanges)
    .all()
    .map((q) => [q.startedAt.getTime(), q.endedAt.getTime()]);

const T = Date.parse("2026-11-20T10:00:00Z");
afterEach(() => {
  setSystemTime();
});

test.each([30_000, -30_000])(
  "with the phone's clock %d ms off, the range is on the server's: it opens when the server takes it, a retry however late answers it as first opened, and it ends when the close arrives",
  async (skew) => {
    setSystemTime(new Date(T));
    const body = opening(T + skew);
    const opened = {
      endsBy: iso(T + DICTATION_CAP_MS),
      id: body.id,
      startedAt: iso(T),
    };
    const first = await open(body);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(opened);
    expect(limit()).toBe(T - CLOCK_MARGIN_MS);
    // The answer was lost; the phone asks again 5 minutes on, its start now stale.
    setSystemTime(new Date(T + 5 * 60_000));
    const again = await open(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(opened);

    setSystemTime(new Date(T + 5 * 60_000 + 4000));
    const closed = await close(body.id);
    expect(closed.status).toBe(200);
    const range = await closed.json();
    expect(stored()).toEqual([
      [T - CLOCK_MARGIN_MS, T + 5 * 60_000 + 4000 + CLOCK_MARGIN_MS],
    ]);
    expect(limit()).toBe(8.64e15);
    // A close again keeps the first end; an open again never reopens it.
    setSystemTime(new Date(T + 6 * 60_000));
    expect(await (await close(body.id)).json()).toEqual(range);
    expect((await open(body)).status).toBe(409);
  }
);

test("refused: a new open a minute off the server's clock, an id never opened, another quiet range's id, a reader's token", async () => {
  const now = clock().getTime();
  expect((await open(opening(now - 61_000))).status).toBe(400);
  expect((await open(opening(now + 61_000))).status).toBe(400);
  expect((await close(randomUUID())).status).toBe(404);
  const playback = randomUUID();
  env.db
    .insert(quietRanges)
    .values({
      endedAt: new Date(now),
      id: playback,
      source: "playback",
      startedAt: new Date(now - 1000),
    })
    .run();
  expect((await close(playback)).status).toBe(404);
  expect((await open(opening(now), READ_TOKEN)).status).toBe(403);
  expect(env.db.select().from(phoneDictations).all()).toEqual([]);
});

test("overlapping dictations: the limit holds at the earliest still open; a close past the cap ends at the cap", () => {
  const t = Date.parse("2026-11-20T10:00:00Z");
  const first = opening(t);
  const second = opening(t + 30_000);
  openPhoneDictation(env.db, first, new Date(t));
  openPhoneDictation(env.db, second, new Date(t + 30_000));
  // Before its cap nothing ends.
  expect(settlePhoneDictations(env.db, new Date(t + 60_000)).ended).toBe(0);
  expect(limit()).toBe(t - CLOCK_MARGIN_MS);
  // The first's close is lost; at its cap it ends there, and the second still holds.
  const { ended, next } = settlePhoneDictations(
    env.db,
    new Date(t + DICTATION_CAP_MS)
  );
  expect({ ended, next }).toEqual({
    ended: 1,
    next: t + 30_000 + DICTATION_CAP_MS,
  });
  expect(stored()).toEqual([
    [t - CLOCK_MARGIN_MS, t + DICTATION_CAP_MS + CLOCK_MARGIN_MS],
  ]);
  expect(limit()).toBe(t + 30_000 - CLOCK_MARGIN_MS);
});

test("a restart ends a dictation past its cap and keeps one inside it open, waking nothing before the first tick reads the credits", () => {
  const now = clock().getTime();
  const lost = opening(now - DICTATION_CAP_MS - 1000);
  const going = opening(now - 60_000);
  env.db
    .insert(phoneDictations)
    .values(
      [lost, going].map((o) => ({ ...o, startedAt: new Date(o.startedAt) }))
    )
    .run();
  // index.ts at start, before any work.
  const config = testConfig("http://localhost:1");
  const worker = jobWorker(env.db, config, memoryAudioStore());
  let pokes = 0;
  worker.poke = () => {
    pokes += 1;
  };
  services(config, env.db, {
    intelligence: null,
    search: null,
    worker,
  }).settleDictations();
  expect(pokes).toBe(0);
  expect(stored()).toEqual([
    [
      Date.parse(lost.startedAt) - CLOCK_MARGIN_MS,
      Date.parse(lost.startedAt) + DICTATION_CAP_MS + CLOCK_MARGIN_MS,
    ],
  ]);
  expect(
    env.db
      .select()
      .from(phoneDictations)
      .all()
      .filter((o) => o.endedAt === null)
      .map((o) => o.id)
  ).toEqual([going.id]);
  expect(limit()).toBe(Date.parse(going.startedAt) - CLOCK_MARGIN_MS);
});

test("an open replayed past its cap ends the dictation at its cap and answers 409", async () => {
  setSystemTime(new Date(T));
  const body = opening(T);
  expect((await open(body)).status).toBe(200);
  setSystemTime(new Date(T + DICTATION_CAP_MS + 100));
  expect((await open(body)).status).toBe(409);
  expect(stored()).toEqual([
    [T - CLOCK_MARGIN_MS, T + DICTATION_CAP_MS + CLOCK_MARGIN_MS],
  ]);
  expect(limit()).toBe(8.64e15);
});

test("an upload's clock is kept for its source, and every answer carries the server's; a source with none is held whole once a dictation exists", async () => {
  const put = (sourceId: string, clockOffset: string) =>
    app.request(`/sources/${sourceId}/timeline`, {
      body: "{}",
      headers: {
        Authorization: `Bearer ${OWNER_TOKEN}`,
        "Content-Type": "application/json",
        "X-Clock-Offset": clockOffset,
      },
      method: "PUT",
    });
  setSystemTime(new Date(T));
  const answer = await put("omi-slow", "-30000,400");
  expect(answer.headers.get("X-Server-Time")).toBe(String(T));
  await put("omi-unsure", "0,60000");
  await put("omi-garbled", "soon");
  await put("omi-empty", ",");
  expect(limit("omi-unknown")).toBe(8.64e15);

  await open(opening(T));
  // Its clock 30 s slow: the dictation's start falls 30 s earlier in its audio, widened by its 0.4 s
  // and the margin.
  expect(limit("omi-slow")).toBe(T - 30_000 - 400 - CLOCK_MARGIN_MS);
  for (const unplaced of [
    "omi-unsure",
    "omi-garbled",
    "omi-empty",
    "omi-unknown",
  ]) {
    expect(limit(unplaced)).toBe(-8.64e15);
  }
});
