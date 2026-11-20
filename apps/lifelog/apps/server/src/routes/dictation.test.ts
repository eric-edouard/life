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
import { openQuietRanges } from "@lifelog/db/schema/open-quiet-ranges";
import { createApp } from "../app";
import { memoryAudioStore } from "../audio-store";
import { sha256Hex } from "../config";
import { jobWorker } from "../jobs";
import {
  CLOCK_MARGIN_MS,
  DICTATION_CAP_MS,
  openQuietRange,
  processingLimit,
  settleOpenQuietRanges,
} from "../quiet-ranges";
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
// The Mac vouching for everything: the limit is the phone's alone.
const MAC = { vouchedThrough: () => new Date(8.64e15) };
const limit = () => processingLimit(env.db, MAC)().getTime();
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

test("refused: a new open a minute off the server's clock, an id never opened, a reader's token", async () => {
  const now = clock().getTime();
  expect((await open(opening(now - 61_000))).status).toBe(400);
  expect((await open(opening(now + 61_000))).status).toBe(400);
  expect((await close(randomUUID())).status).toBe(404);
  expect((await open(opening(now), READ_TOKEN)).status).toBe(403);
  expect(env.db.select().from(openQuietRanges).all()).toEqual([]);
});

test("overlapping dictations: the limit holds at the earliest still open; a close past the cap ends at the cap", () => {
  const t = Date.parse("2026-11-20T10:00:00Z");
  const first = opening(t);
  const second = opening(t + 30_000);
  openQuietRange(env.db, first, new Date(t));
  openQuietRange(env.db, second, new Date(t + 30_000));
  // Before its cap nothing ends.
  expect(settleOpenQuietRanges(env.db, new Date(t + 60_000)).ended).toBe(0);
  expect(limit()).toBe(t - CLOCK_MARGIN_MS);
  // The first's close is lost; at its cap it ends there, and the second still holds.
  const { ended, next } = settleOpenQuietRanges(
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
    .insert(openQuietRanges)
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
      .from(openQuietRanges)
      .all()
      .map((o) => o.id)
  ).toEqual([going.id]);
  expect(limit()).toBe(Date.parse(going.startedAt) - CLOCK_MARGIN_MS);
});
