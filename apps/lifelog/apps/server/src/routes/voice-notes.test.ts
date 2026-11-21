import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { voiceNoteHearings } from "@lifelog/db/schema/voice-note-hearings";
import { createApp } from "../app";
import { sha256Hex } from "../config";
import {
  fakeElevenLabs,
  fakeSpeechService,
  heardInBangkok,
  OWNER_TOKEN,
  pendantOgg,
  scribeThai,
  speechServices,
  spokenTurn,
  spokenWord,
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
  heardInBangkok(env.db);
});

const app = () => createApp(speechServices(scribe, speech, env.db));
const ask = (
  a: ReturnType<typeof app>,
  audio: Uint8Array,
  key: string,
  signal?: AbortSignal
) =>
  a.request(`/voice-notes/transcript?at=2026-11-19T10:50:37Z&key=${key}`, {
    body: audio as BodyInit,
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "audio/ogg",
    },
    method: "POST",
    signal,
  });
// English, a Thai turn, French: the worker's own mix (jobs.test.ts); only the Thai turn goes to Scribe.
const MIXED = {
  durationSeconds: 60,
  models: {},
  turns: [
    spokenTurn(0, 10, "en"),
    spokenTurn(10, 14, "th"),
    spokenTurn(14, 60, "fr"),
  ],
  words: [spokenWord(1, "Hello"), spokenWord(15, "Salut")],
};
const LOCAL = "Hello Salut";
const sends = () =>
  scribe.calls.filter((c) => c.path.endsWith("/speech-to-text"));

test("an English note is heard on the Mac alone", async () => {
  speech.heard = {
    durationSeconds: 10,
    models: {},
    turns: [spokenTurn(0, 10, "en")],
    words: [
      spokenWord(1, "See"),
      spokenWord(2, "you"),
      spokenWord(3, "tonight"),
    ],
  };
  const res = await ask(app(), pendantOgg(10), sha256Hex(randomUUID()));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: "See you tonight" });
  expect(sends()).toHaveLength(0);
});

test("a Thai turn goes to Scribe once; asked again, its words come back with no send", async () => {
  speech.heard = MIXED;
  scribe.respond = scribeThai;
  const a = app();
  const key = sha256Hex(randomUUID());
  const first = await (await ask(a, pendantOgg(60), key)).json();
  expect(first.text).toContain("Hello");
  expect(first.text).toContain("สวัสดี");
  const again = await ask(a, pendantOgg(60), key);
  expect(await again.json()).toEqual(first);
  expect(sends()).toHaveLength(1);
});

test("Scribe failing after it may have billed: the local words stand, never sent again", async () => {
  speech.heard = MIXED;
  scribe.respond = () => new Response("boom", { status: 500 });
  const a = app();
  const key = sha256Hex(randomUUID());
  expect(await (await ask(a, pendantOgg(60), key)).json()).toEqual({
    text: LOCAL,
  });
  expect(await (await ask(a, pendantOgg(60), key)).json()).toEqual({
    text: LOCAL,
  });
  expect(sends()).toHaveLength(1);
});

test("Scribe taking nothing now: busy, and the note may be sent again", async () => {
  speech.heard = MIXED;
  scribe.respond = () => new Response("slow down", { status: 429 });
  const a = app();
  const key = sha256Hex(randomUUID());
  expect((await ask(a, pendantOgg(60), key)).status).toBe(503);
  scribe.respond = scribeThai;
  expect((await (await ask(a, pendantOgg(60), key)).json()).text).toContain(
    "สวัสดี"
  );
  expect(sends()).toHaveLength(2);
});

test("the speech service busy: 503; not Ogg Opus: 400", async () => {
  speech.busy = true;
  expect((await ask(app(), pendantOgg(5), sha256Hex("a"))).status).toBe(503);
  speech.busy = false;
  const res = await ask(app(), new Uint8Array([1, 2, 3]), sha256Hex("b"));
  expect(res.status).toBe(400);
});

test("a send cut off (a crash, a lost answer) is never sent again: past 5 minutes the Mac's words stand", async () => {
  speech.heard = MIXED;
  scribe.respond = scribeThai;
  const key = sha256Hex(randomUUID());
  env.db
    .insert(voiceNoteHearings)
    .values({ claimedAt: new Date(), key, localText: LOCAL })
    .run();
  const a = app();
  expect((await ask(a, pendantOgg(60), key)).status).toBe(503);
  setSystemTime(Date.now() + 6 * 60 * 1000);
  try {
    expect(await (await ask(a, pendantOgg(60), key)).json()).toEqual({
      text: LOCAL,
    });
  } finally {
    setSystemTime();
  }
  expect(sends()).toHaveLength(0);
});

test("no Scribe slot now (dictation holds the one): busy, nothing claimed, and the note goes once it is free", async () => {
  speech.heard = MIXED;
  scribe.respond = scribeThai;
  const s = speechServices(scribe, speech, env.db, { ELEVENLABS_SLOTS: "1" });
  const a = createApp(s);
  let free: () => void = () => undefined;
  const dictation = s.worker.paidSend(
    "dictation",
    { priority: "interactive", waitMs: 0 },
    () => null,
    () =>
      new Promise<void>((end) => {
        free = end;
      })
  );
  const key = sha256Hex(randomUUID());
  expect((await ask(a, pendantOgg(60), key)).status).toBe(503);
  expect(sends()).toHaveLength(0);
  expect(env.db.select().from(voiceNoteHearings).all()).toHaveLength(0);
  free();
  await dictation;
  expect((await (await ask(a, pendantOgg(60), key)).json()).text).toContain(
    "สวัสดี"
  );
  expect(sends()).toHaveLength(1);
});

test("a note keeps its Scribe slot until its words are stored: the next grant sees them", async () => {
  speech.heard = MIXED;
  const s = speechServices(scribe, speech, env.db, { ELEVENLABS_SLOTS: "1" });
  const a = createApp(s);
  const key = sha256Hex(randomUUID());
  let next: Promise<unknown> = Promise.resolve();
  const seen: (Date | null)[] = [];
  scribe.respond = (call) => {
    if (call.path.endsWith("/v1/user/subscription")) {
      return Response.json({});
    }
    next = s.worker.paidSend(
      "dictation",
      { priority: "interactive", waitMs: 5000 },
      () => {
        seen.push(
          env.db.select().from(voiceNoteHearings).get()?.doneAt ?? null
        );
        return null;
      },
      () => Promise.resolve()
    );
    return scribeThai();
  };
  expect((await ask(a, pendantOgg(60), key)).status).toBe(200);
  await next;
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBeInstanceOf(Date);
});

test("a note whose caller left while the speech service heard it is never sent to Scribe", async () => {
  speech.heard = MIXED;
  scribe.respond = scribeThai;
  const left = new AbortController();
  speech.meanwhile = () => left.abort();
  try {
    await Promise.resolve(
      ask(app(), pendantOgg(60), sha256Hex(randomUUID()), left.signal)
    ).catch(() => undefined);
  } finally {
    speech.meanwhile = () => undefined;
  }
  expect(sends()).toHaveLength(0);
  expect(env.db.select().from(voiceNoteHearings).all()).toHaveLength(0);
});
