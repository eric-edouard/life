import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { heartbeats } from "@lifelog/db/schema";
import { createApp } from "../app";
import { pendantOggOpus } from "../audio";
import { services } from "../services";
import {
  fakeElevenLabs,
  fakeSpeechService,
  OWNER_TOKEN,
  testConfig,
  testDb,
} from "../testing";

const scribe = fakeElevenLabs();
const speech = fakeSpeechService();
let env: Awaited<ReturnType<typeof testDb>>;
beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
  scribe.server.stop(true);
  speech.server.stop(true);
});
beforeEach(() => {
  env.reset();
  scribe.calls.length = 0;
  speech.priorities.length = 0;
  // Where Thai is spoken: the router's lower bar.
  env.db
    .insert(heartbeats)
    .values({
      body: { timeZone: "Asia/Bangkok" },
      id: randomUUID(),
      observedAt: new Date(0),
      reason: "periodic",
      receivedAt: new Date(0),
    })
    .run();
});

const servicesWith = (overrides: Record<string, string> = {}) =>
  services(
    testConfig(`http://localhost:${scribe.server.port}`, {
      IDENTITY_SECRET: "speech-test-secret",
      IDENTITY_URL: `http://localhost:${speech.server.port}`,
      ...overrides,
    }),
    env.db
  );
const said = (seconds: number) =>
  pendantOggOpus(
    Array.from(
      { length: seconds * 50 },
      (_, i) => new Uint8Array([8, i % 256, Math.floor(i / 256)])
    ),
    seconds * 1000
  );
const dictate = (a = createApp(servicesWith()), audio = said(60)) =>
  a.request("/dictation/transcript", {
    body: audio as BodyInit,
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "audio/ogg",
    },
    method: "POST",
  });
const turn = (start: number, end: number, language: "en" | "th") => ({
  end,
  language,
  scores:
    language === "th"
      ? { en: 0.02, fr: 0.01, th: 0.9 }
      : { en: 0.95, fr: 0.02, th: 0.001 },
  speaker: "0",
  start,
});
const thai = () =>
  Response.json({
    language_code: "tha",
    language_probability: 0.9,
    words: [
      {
        end: 0.8,
        speaker_id: "speaker_0",
        start: 0.5,
        text: "สวัสดี",
        type: "word",
      },
    ],
  });
const sends = () =>
  scribe.calls.filter((c) => c.path.endsWith("/speech-to-text"));
// Whatever the route touched, no table holds the dictation's words.
const keptIn = (words: string) =>
  env.db.$client
    .query("select name from sqlite_master where type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((table) =>
      JSON.stringify(
        env.db.$client.query(`select * from "${table}"`).all()
      ).includes(words)
    );

test("English is heard on the Mac alone, ahead of other work, and nothing of it is kept", async () => {
  speech.heard = {
    durationSeconds: 3,
    models: {},
    turns: [turn(0, 3, "en")],
    words: [{ end: 1, start: 0.5, text: "Morning" }],
  };
  const res = await dictate(undefined, said(3));
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual({ text: "Morning" });
  expect(speech.priorities).toEqual(["interactive"]);
  expect(sends()).toHaveLength(0);
  expect(keptIn("Morning")).toEqual([]);
});

test("a Thai turn goes to Scribe once, after the waiting work, while a slot is held", async () => {
  speech.heard = {
    durationSeconds: 60,
    models: {},
    turns: [turn(0, 10, "en"), turn(10, 60, "th")],
    words: [{ end: 1.3, start: 1, text: "Hello" }],
  };
  scribe.respond = thai;
  const s = servicesWith({ ELEVENLABS_SLOTS: "1" });
  // The one slot is held: dictation waits for it rather than answering busy.
  let free: () => void = () => undefined;
  const held = s.worker.paidSend(
    "a block",
    { priority: "ordinary", waitMs: 0 },
    () => null,
    () =>
      new Promise<void>((end) => {
        free = end;
      })
  );
  const asked = dictate(createApp(s));
  await Bun.sleep(50);
  expect(sends()).toHaveLength(0);
  free();
  await held;
  const res = await asked;
  expect(res.status).toBe(200);
  expect((await res.json()).text).toContain("สวัสดี");
  expect(sends()).toHaveLength(1);
});

test("Scribe failing after it may have billed: the field says it again, never the Mac's words", async () => {
  speech.heard = {
    durationSeconds: 60,
    models: {},
    turns: [turn(0, 10, "en"), turn(10, 60, "th")],
    words: [{ end: 1.3, start: 1, text: "Hello" }],
  };
  scribe.respond = () => new Response("boom", { status: 500 });
  const res = await dictate();
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("transcription_failed");
  scribe.respond = () => new Response("slow down", { status: 429 });
  expect((await dictate()).status).toBe(503);
  expect(sends()).toHaveLength(2);
});

test("the speech service busy: 503; not Ogg Opus: 400", async () => {
  speech.busy = true;
  try {
    expect((await dictate(undefined, said(5))).status).toBe(503);
  } finally {
    speech.busy = false;
  }
  expect((await dictate(undefined, new Uint8Array([1, 2, 3]))).status).toBe(
    400
  );
});
