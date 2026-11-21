import { expect, spyOn, test } from "bun:test";
import { listEvents } from "./events";
import { jobBench } from "./job-bench";

const { admitFragment, appWith, audio, env, fake } = jobBench();

// 21 Nov 2026: Scribe's refusal body (its words can be the provider's) went into the server's log and its events.
test("a refusal from Scribe reaches neither the server's log nor its events: its kind says what happened", async () => {
  const app = appWith();
  fake.respond = () =>
    new Response('{"detail":"Mia said hi"}', { status: 422 });
  const printed = spyOn(console, "log");
  try {
    await admitFragment(app, audio(60), 1);
    await app.s.worker.work();
    const events = listEvents(env.db, { limit: 500, since: "2000-01-01" });
    expect(events.some((e) => e.name.startsWith("elevenlabs."))).toBe(true);
    expect(JSON.stringify([printed.mock.calls, events])).not.toContain("Mia");
  } finally {
    printed.mockRestore();
  }
});
