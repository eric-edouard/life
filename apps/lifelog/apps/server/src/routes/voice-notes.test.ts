import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { heartbeats } from "@lifelog/db/schema";
import { voiceNoteHearings } from "@lifelog/db/schema/voice-note-hearings";
import { createApp } from "../app";
import { pendantOggOpus } from "../audio";
import { sha256Hex } from "../config";
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
  speech.busy = false;
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

const app = () =>
  createApp(
    services(
      testConfig(`http://localhost:${scribe.server.port}`, {
        IDENTITY_SECRET: "speech-test-secret",
        IDENTITY_URL: `http://localhost:${speech.server.port}`,
      }),
      env.db
    )
  );
const note = (seconds: number) =>
  pendantOggOpus(
    Array.from(
      { length: seconds * 50 },
      (_, i) => new Uint8Array([8, i % 256, Math.floor(i / 256)])
    ),
    seconds * 1000
  );
const ask = (a: ReturnType<typeof app>, audio: Uint8Array, key: string) =>
  a.request(`/voice-notes/transcript?at=2026-11-19T10:50:37Z&key=${key}`, {
    body: audio as BodyInit,
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "audio/ogg",
    },
    method: "POST",
  });
const SCORES = {
  en: { en: 0.95, fr: 0.02, th: 0.001 },
  fr: { en: 0.02, fr: 0.95, th: 0.001 },
  th: { en: 0.02, fr: 0.01, th: 0.9 },
};
const turn = (start: number, end: number, language: keyof typeof SCORES) => ({
  end,
  language,
  scores: SCORES[language],
  speaker: language === "th" ? "1" : "0",
  start,
});
const word = (start: number, text: string) => ({
  end: start + 0.3,
  start,
  text,
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
// English, a Thai turn, French: the worker's own mix (jobs.test.ts); only the Thai turn goes to Scribe.
const MIXED = {
  durationSeconds: 60,
  models: {},
  turns: [turn(0, 10, "en"), turn(10, 14, "th"), turn(14, 60, "fr")],
  words: [word(1, "Hello"), word(15, "Salut")],
};
const LOCAL = "Hello Salut";
const sends = () =>
  scribe.calls.filter((c) => c.path.endsWith("/speech-to-text"));

test("an English note is heard on the Mac alone", async () => {
  speech.heard = {
    durationSeconds: 10,
    models: {},
    turns: [turn(0, 10, "en")],
    words: [word(1, "See"), word(2, "you"), word(3, "tonight")],
  };
  const res = await ask(app(), note(10), sha256Hex(randomUUID()));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: "See you tonight" });
  expect(sends()).toHaveLength(0);
});

test("a Thai turn goes to Scribe once; asked again, its words come back with no send", async () => {
  speech.heard = MIXED;
  scribe.respond = thai;
  const a = app();
  const key = sha256Hex(randomUUID());
  const first = await (await ask(a, note(60), key)).json();
  expect(first.text).toContain("Hello");
  expect(first.text).toContain("สวัสดี");
  const again = await ask(a, note(60), key);
  expect(await again.json()).toEqual(first);
  expect(sends()).toHaveLength(1);
});

test("Scribe failing after it may have billed: the local words stand, never sent again", async () => {
  speech.heard = MIXED;
  scribe.respond = () => new Response("boom", { status: 500 });
  const a = app();
  const key = sha256Hex(randomUUID());
  expect(await (await ask(a, note(60), key)).json()).toEqual({ text: LOCAL });
  expect(await (await ask(a, note(60), key)).json()).toEqual({ text: LOCAL });
  expect(sends()).toHaveLength(1);
});

test("Scribe taking nothing now: busy, and the note may be sent again", async () => {
  speech.heard = MIXED;
  scribe.respond = () => new Response("slow down", { status: 429 });
  const a = app();
  const key = sha256Hex(randomUUID());
  expect((await ask(a, note(60), key)).status).toBe(503);
  scribe.respond = thai;
  expect((await (await ask(a, note(60), key)).json()).text).toContain("สวัสดี");
  expect(sends()).toHaveLength(2);
});

test("the speech service busy: 503; not Ogg Opus: 400", async () => {
  speech.busy = true;
  expect((await ask(app(), note(5), sha256Hex("a"))).status).toBe(503);
  speech.busy = false;
  const res = await ask(app(), new Uint8Array([1, 2, 3]), sha256Hex("b"));
  expect(res.status).toBe(400);
});

test("a send cut off (a crash, a lost answer) is never sent again: past 5 minutes the Mac's words stand", async () => {
  speech.heard = MIXED;
  scribe.respond = thai;
  const key = sha256Hex(randomUUID());
  env.db
    .insert(voiceNoteHearings)
    .values({ claimedAt: new Date(), key, localText: LOCAL })
    .run();
  const a = app();
  expect((await ask(a, note(60), key)).status).toBe(503);
  setSystemTime(Date.now() + 6 * 60 * 1000);
  try {
    expect(await (await ask(a, note(60), key)).json()).toEqual({ text: LOCAL });
  } finally {
    setSystemTime();
  }
  expect(sends()).toHaveLength(0);
});
