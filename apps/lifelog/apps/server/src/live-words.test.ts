import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApp } from "./app";
import { services } from "./services";
import { setSwitches } from "./switches";
import { fakeElevenLabs, OWNER_TOKEN, testConfig, testDb } from "./testing";

const fake = fakeElevenLabs();
afterAll(() => fake.server.stop(true));

let store: ReturnType<typeof testDb>;
beforeAll(() => {
  store = testDb();
  setSwitches(store.db, { dictationHeard: "instant" });
});
afterAll(() => {
  setSwitches(store.db, { dictationHeard: "mac" });
  store.drop();
});

const ask = () =>
  createApp(
    services(testConfig(`http://localhost:${fake.server.port}`), store.db, {
      intelligence: null,
    })
  ).request("/live-words/token", {
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    method: "POST",
  });

test("hands the phone ElevenLabs' single-use token, asked with the Mac's key", async () => {
  fake.respond = () => Response.json({ token: "sutkn_made_up" });
  const res = await ask();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ token: "sutkn_made_up" });
  expect(fake.calls.at(-1)?.path).toBe("/v1/single-use-token/realtime_scribe");
});

test("refuses a token while dictation is heard on the Mac, asking ElevenLabs nothing", async () => {
  setSwitches(store.db, { dictationHeard: "mac" });
  const before = fake.calls.length;
  const res = await ask();
  setSwitches(store.db, { dictationHeard: "instant" });
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toBe(
    "transcription_off"
  );
  expect(fake.calls.length).toBe(before);
});

test("a refusal from ElevenLabs is a 502, never a token", async () => {
  fake.respond = () => new Response("no", { status: 401 });
  expect((await ask()).status).toBe(502);
});

test("needs the device token", async () => {
  const app = createApp(
    services(testConfig("http://localhost:1"), store.db, { intelligence: null })
  );
  expect(
    (await app.request("/live-words/token", { method: "POST" })).status
  ).toBe(401);
});
