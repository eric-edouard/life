import { afterAll, beforeEach, expect, test } from "bun:test";
import { voiceSamples } from "@lifelog/db/schema";
import { assign, isRejected, keepServerSamples } from "./people";

import { expire, strangerRows } from "./speaker-recognition";
import { seedConversation, testDb } from "./testing";

const env = testDb();
afterAll(() => env.drop());
beforeEach(() => env.reset());

test("rejection keeps named and candidate evidence, excludes strangers and owner unknown/media", () => {
  expect(isRejected(undefined)).toBe(false);
  for (const source of ["owner", "recognized"] as const) {
    for (const status of [
      "person",
      "unknown",
      "media",
      "stranger",
      "candidate",
    ] as const) {
      for (const candidates of [null, { people: ["guest"], unknown: true }]) {
        expect(isRejected({ candidates, source, status })).toBe(
          status === "stranger" ||
            (source === "owner" &&
              candidates === null &&
              (status === "unknown" || status === "media"))
        );
      }
    }
  }
});

test("media expiry respects a turn's own unknown answer, preserving its negative reference", () => {
  const { db } = env;
  const { id, jobId } = seedConversation(db, [
    { end: 5, speakerId: "speaker_0", start: 0, text: "Made up words" },
    { end: 10, speakerId: "speaker_0", start: 5, text: "Other words" },
  ]);
  keepServerSamples(
    db,
    jobId,
    [0, 1].map((turnIndex) => ({
      conversationId: id,
      durationSeconds: 5,
      embedding: [1, 0],
      jobId,
      modelId: "test",
      modelRevision: "r1",
      speakerLabel: "speaker_0",
      turnIndex,
    }))
  );
  assign(db, {
    jobId,
    speakerLabel: "speaker_0",
    target: { kind: "media" },
    turnIndex: null,
  });
  assign(db, {
    jobId,
    speakerLabel: "speaker_0",
    target: { kind: "unknown" },
    turnIndex: 1,
  });
  expect(strangerRows(db)).toHaveLength(1);
  expect(expire(db)).toBe(1);
  expect(
    db
      .select()
      .from(voiceSamples)
      .all()
      .map((s) => s.turnIndex)
  ).toEqual([1]);
  expect(strangerRows(db)).toHaveLength(1);
});
