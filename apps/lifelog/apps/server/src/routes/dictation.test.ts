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
import { sha256Hex } from "../config";
import { DICTATION_CAP_MS } from "../phone-dictations";
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
const T = Date.parse("2026-11-20T10:00:00Z");
afterEach(() => {
  setSystemTime();
});

test.each([30_000, -30_000])(
  "with the phone's clock %d ms off, the dictation is on the server's: it opens when the server takes it, a retry however late answers it as first opened, it ends when the close arrives, and no quiet range comes of it",
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
    expect(await first.json()).toEqual({ ...opened, endedAt: null });
    // The answer was lost; the phone asks again 5 minutes on, its start now stale.
    setSystemTime(new Date(T + 5 * 60_000));
    const again = await open(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ...opened, endedAt: null });

    setSystemTime(new Date(T + 5 * 60_000 + 4000));
    const closed = await close(body.id);
    expect(closed.status).toBe(200);
    const range = await closed.json();
    expect(range).toEqual({ ...opened, endedAt: iso(T + 5 * 60_000 + 4000) });
    expect(env.db.select().from(quietRanges).all()).toEqual([]);
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

test("past its cap a dictation is over: an open replayed answers 409, and a late close ends it at its cap", async () => {
  setSystemTime(new Date(T));
  const body = opening(T);
  expect((await open(body)).status).toBe(200);
  setSystemTime(new Date(T + DICTATION_CAP_MS + 100));
  expect((await open(body)).status).toBe(409);
  const closed = await close(body.id);
  expect((await closed.json()).endedAt).toBe(iso(T + DICTATION_CAP_MS));
});
