import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { countRows } from "@life/voice-db";
import { quickTranscriptions, transcriptionJobs } from "@life/voice-db/schema";
import { createApp } from "./app";
import { services } from "./services";
import { setSwitches } from "./switches";
import {
  fakeElevenLabs,
  OWNER_TOKEN,
  oggOpus,
  providerTranscript,
  testConfig,
  testDb,
} from "./testing";
import { usageSummary } from "./usage";

const fake = fakeElevenLabs();
let env: Awaited<ReturnType<typeof testDb>>;
let app: ReturnType<typeof createApp>;
const config = testConfig(`http://localhost:${fake.server.port}`);

beforeAll(() => {
  env = testDb();
  app = createApp(services(config, env.db));
});
afterAll(() => {
  env.drop();
  fake.server.stop(true);
});
beforeEach(() => {
  env.reset();
  setSwitches(env.db, { transcription: true });
  fake.calls = [];
  fake.respond = () => Response.json(providerTranscript);
});

const ask = (seconds = 60) => {
  const form = new FormData();
  form.append("audio", new Blob([oggOpus(seconds)]), "press.ogg");
  return app.request("/quick-transcriptions", {
    body: form,
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    method: "POST",
  });
};

test("a press's audio comes back as words at once; only its cost is kept, and it counts", async () => {
  const res = await ask();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: "Hello there. Bonjour!" });
  const form = fake.calls[0]?.form;
  expect([
    form?.get("model_id"),
    form?.get("diarize"),
    form?.get("webhook"),
  ]).toEqual(["scribe_v2", "false", null]);
  const [row] = env.db.select().from(quickTranscriptions).all();
  expect(row?.durationSeconds).toBe(60);
  expect(
    (await usageSummary(env.db, config)).today.transcription.hours
  ).toBeCloseTo(60 / 3600);
});

test("refused while transcription is off, and when ElevenLabs fails", async () => {
  setSwitches(env.db, { transcription: false });
  expect((await ask()).status).toBe(409);
  setSwitches(env.db, { transcription: true });
  expect((await ask(121)).status).toBe(400);
  fake.respond = () => new Response("down", { status: 503 });
  expect((await ask()).status).toBe(502);
  // A 5xx may have been billed: it counts.
  expect(countRows(env.db, quickTranscriptions)).toBe(1);
  expect(countRows(env.db, transcriptionJobs)).toBe(0);
});
