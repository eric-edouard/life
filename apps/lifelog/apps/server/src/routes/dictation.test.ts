import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createApp } from "../app";
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
  speech.priorities.length = 0;
  heardInBangkok(env.db);
});

const LONG = 60_000;
const servicesWith = (overrides: Record<string, string> = {}) =>
  speechServices(scribe, speech, env.db, overrides);
const dictate = (a = createApp(servicesWith()), audio = pendantOgg(60)) =>
  a.request("/dictation/transcript", {
    body: audio as BodyInit,
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "audio/ogg",
    },
    method: "POST",
  });
// English, a Thai turn, French: only the Thai turn goes to Scribe.
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
    turns: [spokenTurn(0, 3, "en")],
    words: [spokenWord(0.5, "Morning")],
  };
  const res = await dictate(undefined, pendantOgg(3));
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual({ text: "Morning" });
  expect(speech.priorities).toEqual(["interactive"]);
  expect(sends()).toHaveLength(0);
  expect(keptIn("Morning")).toEqual([]);
});

test("a Thai turn waits for the held slot, then goes to Scribe once, ahead of an older ordinary waiter", async () => {
  speech.heard = MIXED;
  scribe.respond = scribeThai;
  const s = servicesWith({ ELEVENLABS_SLOTS: "1" });
  const order: string[] = [];
  let free: () => void = () => undefined;
  // The one slot is held, and an ordinary send waits for it.
  await new Promise<void>((holding) => {
    s.worker.paidSend(
      "a block",
      { priority: "ordinary", waitMs: LONG },
      () => null,
      () => {
        holding();
        return new Promise<void>((end) => {
          free = end;
        });
      }
    );
  });
  const older = s.worker.paidSend(
    "another block",
    { priority: "ordinary", waitMs: LONG },
    () => null,
    () => {
      order.push("ordinary");
      return Promise.resolve();
    }
  );
  const { paidSend } = s.worker;
  const joined = new Promise<void>((join) => {
    s.worker.paidSend = (key, until, claim, post) => {
      join();
      return paidSend(key, until, claim, () => {
        order.push("dictation");
        return post();
      });
    };
  });
  const asked = dictate(createApp(s));
  await joined;
  // Its wait joins the line once the credits' first read settles: within this turn's microtasks.
  await Bun.sleep(0);
  expect(sends()).toHaveLength(0);
  free();
  const res = await asked;
  await older;
  expect(res.status).toBe(200);
  expect((await res.json()).text).toBe("Hello สวัสดี Salut");
  expect(order).toEqual(["dictation", "ordinary"]);
  expect(sends()).toHaveLength(1);
});

test("Scribe answering no words for a Thai turn: the field says it again, never the Mac's words alone", async () => {
  speech.heard = MIXED;
  scribe.respond = () =>
    Response.json({
      language_code: "tha",
      language_probability: 0.9,
      words: [],
    });
  const res = await dictate();
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("transcription_failed");
});

test("Scribe failing after it may have billed: 502; refusing: 503", async () => {
  speech.heard = MIXED;
  scribe.respond = () => new Response("boom", { status: 500 });
  const res = await dictate();
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("transcription_failed");
  scribe.respond = () => new Response("slow down", { status: 429 });
  expect((await dictate()).status).toBe(503);
  expect(sends()).toHaveLength(2);
});

test("the speech service busy or its answer cut off: 503; not Ogg Opus: 400", async () => {
  speech.busy = true;
  try {
    expect((await dictate(undefined, pendantOgg(5))).status).toBe(503);
  } finally {
    speech.busy = false;
  }
  speech.cutOff = true;
  try {
    expect((await dictate(undefined, pendantOgg(5))).status).toBe(503);
  } finally {
    speech.cutOff = false;
  }
  expect((await dictate(undefined, new Uint8Array([1, 2, 3]))).status).toBe(
    400
  );
  expect(sends()).toHaveLength(0);
});
