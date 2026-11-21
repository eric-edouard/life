import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  intelligenceRuns,
  transcriptionJobs,
  voiceNoteHearings,
} from "@lifelog/db/schema";
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

test("a span's spending: settled jobs billed, a send that may have billed apart, unsettled ones marked, a failed one that billed nothing left out; notes by their answer; settled model runs", () => {
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
  for (const state of ["valid", "running"] as const) {
    db.insert(intelligenceRuns)
      .values({
        conversationId: randomUUID(),
        createdAt: AT,
        inputTokens: 100,
        model: "claude-sonnet-5-5",
        outputTokens: 10,
        promptVersion: 1,
        provider: "claude-code",
        state,
        turns: [],
      })
      .run();
  }
  const s = spendingOf(
    db,
    new Date("2026-11-20T00:00:00.000Z"),
    new Date("2026-11-21T00:00:00.000Z")
  );
  expect(s.jobs.map((j) => j.outcome).toSorted()).toEqual([
    "billed",
    "maybe_billed",
    "unsettled",
  ]);
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
      latencyMs: null,
      model: "claude-sonnet-5-5",
      outputTokens: 10,
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
  ).toEqual({ jobs: [], modelRuns: [], voiceNotes: [] });
});
