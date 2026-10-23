import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { intelligenceRuns, type Turn } from "@life/voice-db/schema";
import { createApp } from "./app";
import { services } from "./services";
import {
  fakeModel,
  OWNER_TOKEN,
  rollNow,
  seedConversation,
  testConfig,
  testDb,
} from "./testing";

let env: Awaited<ReturnType<typeof testDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  env = testDb();
  app = createApp(
    services(testConfig("http://localhost:1"), env.db, {
      intelligence: null,
      search: null,
    })
  );
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
});

const auth = {
  Authorization: `Bearer ${OWNER_TOKEN}`,
  "Content-Type": "application/json",
};
const turns: Turn[] = [
  { end: 4, speakerId: "speaker_0", start: 0, text: "Remember the plumber." },
  { end: 9, speakerId: "speaker_1", start: 5, text: "Monday at nine." },
];
const start = Date.parse("2026-10-01T02:00:00Z");
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const seed = (at = start) => seedConversation(env.db, turns, { at });

async function setTitle(id: string, title: string | null, editedAt?: string) {
  const res = await app.request(`/conversations/${id}/title`, {
    body: JSON.stringify({ editedAt, title }),
    headers: auth,
    method: "PUT",
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    ownerTitle: string | null;
    ownerTitleAt: string | null;
    title: string | null;
    titleSource: string;
  };
}

test("the latest title edit wins by when it was made, and the owner's beats the generated one", async () => {
  const { id } = seed();
  const model = fakeModel();
  await rollNow(env.db, model, id);

  const mac = await setTitle(id, "Plumber visit");
  expect(mac).toMatchObject({ title: "Plumber visit", titleSource: "owner" });
  // Renamed on the phone an hour ago, offline, and only sent now: the Mac's rename is later.
  expect(await setTitle(id, "Old name", ago(60))).toMatchObject({
    ownerTitle: "Plumber visit",
    ownerTitleAt: mac.ownerTitleAt,
  });
  // A phone clock running ahead counts as now.
  const ahead = await setTitle(
    id,
    "Plumber, Monday",
    new Date(Date.now() + 86_400_000).toISOString()
  );
  expect(ahead.ownerTitle).toBe("Plumber, Monday");
  expect(Date.parse(ahead.ownerTitleAt ?? "")).toBeLessThanOrEqual(Date.now());
  // Clearing brings back the generated title; a regeneration never touches the owner's.
  expect(await setTitle(id, null)).toMatchObject({
    title: "Turns 0-1",
    titleSource: "generated",
  });
  await setTitle(id, "Plumber");
  env.db.update(intelligenceRuns).set({ state: "invalid" }).run();
  await rollNow(env.db, model, id);
  expect(await setTitle(id, "Older", ago(1))).toMatchObject({
    title: "Plumber",
    titleSource: "owner",
  });

  const missing = await app.request(`/conversations/${randomUUID()}/title`, {
    body: JSON.stringify({ title: "x" }),
    headers: auth,
    method: "PUT",
  });
  expect(missing.status).toBe(404);
});
