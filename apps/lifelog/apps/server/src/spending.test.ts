import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { intelligenceRuns, transcriptionJobs } from "@lifelog/db/schema";
import { voiceNoteHearings } from "@lifelog/db/schema/voice-note-hearings";
import { spendingOf } from "./spending";
import { testDb } from "./testing";

const { db, drop } = testDb();
afterAll(drop);

const AT = new Date("2026-11-20T10:00:00.000Z");
const job = (state: "completed" | "failed" | "queued", maybeBilled = false) =>
  db
    .insert(transcriptionJobs)
    .values({
      admittedAt: AT,
      audioSha256: randomUUID(),
      billableSeconds: 60,
      maybeBilled,
      preparedDurationSeconds: 50,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: randomUUID(),
      state,
    })
    .run();

test("a span's spending: settled jobs billed, a failed send that may have billed apart, unsettled jobs and runs only counted, a failed one that billed nothing left out; notes by their answer; settled Mac runs", () => {
  job("completed");
  job("failed", true);
  job("queued");
  job("failed");
  db.insert(voiceNoteHearings)
    .values([
      {
        billableSeconds: 12,
        doneAt: AT,
        key: "a",
        localText: "",
        route: "whole",
        seconds: 10,
      },
      // Its answer lost: done, with no seconds.
      { doneAt: AT, key: "b", localText: "" },
      // Still being heard.
      { key: "c", localText: "" },
    ])
    .run();
  for (const [state, provider] of [
    ["valid", "claude-code"],
    ["running", "claude-code"],
    ["valid", "openai"],
  ] as const) {
    db.insert(intelligenceRuns)
      .values({
        conversationId: randomUUID(),
        createdAt: AT,
        inputTokens: 100,
        model: "claude-sonnet-5-5",
        outputTokens: 10,
        promptVersion: 1,
        provider,
        state,
        turns: [],
      })
      .run();
  }
  // Resumed under Codex: its kept Claude answer stays Claude's. A failed run with no answer: no usage, left out.
  db.insert(intelligenceRuns)
    .values([
      {
        conversationId: randomUUID(),
        createdAt: AT,
        inputTokens: 5,
        model: "gpt-6.1-sol",
        outputTokens: 1,
        promptVersion: 1,
        provider: "codex",
        raw: [
          {
            inputTokens: 5,
            latencyMs: 7,
            model: "claude-sonnet-5-5",
            outputTokens: 1,
            provider: "claude-code",
            stage: "voices",
            text: "",
          },
        ],
        state: "valid",
        turns: [],
      },
      {
        conversationId: randomUUID(),
        createdAt: AT,
        model: "gpt-6.1-sol",
        promptVersion: 1,
        provider: "codex",
        state: "failed",
        turns: [],
      },
    ])
    .run();
  const s = spendingOf(
    db,
    new Date("2026-11-20T00:00:00.000Z"),
    new Date("2026-11-21T00:00:00.000Z")
  );
  expect(s.jobs.map((j) => j.outcome).toSorted()).toEqual([
    "billed",
    "maybe_billed",
  ]);
  // The queued job and the running run.
  expect(s.unsettled).toBe(2);
  expect(s.jobs[0]).toMatchObject({
    billableSeconds: 60,
    seconds: 50,
    transcriber: "scribe",
  });
  expect(s.voiceNotes).toEqual([
    { at: AT.toISOString(), billableSeconds: 12, route: "whole", seconds: 10 },
    { at: AT.toISOString(), billableSeconds: null, route: null, seconds: null },
  ]);
  expect(s.modelRuns).toEqual([
    {
      at: AT.toISOString(),
      inputTokens: 100,
      latencyMs: 0,
      model: "claude-sonnet-5-5",
      outputTokens: 10,
      provider: "claude-code",
    },
    {
      at: AT.toISOString(),
      inputTokens: 5,
      latencyMs: 7,
      model: "claude-sonnet-5-5",
      outputTokens: 1,
      provider: "claude-code",
    },
  ]);
  // Outside the span: nothing.
  expect(
    spendingOf(
      db,
      new Date("2026-11-21T00:00:00.000Z"),
      new Date("2026-11-22T00:00:00.000Z")
    )
  ).toEqual({ jobs: [], modelRuns: [], unsettled: 0, voiceNotes: [] });
});
