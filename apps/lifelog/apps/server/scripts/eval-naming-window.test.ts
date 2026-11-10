import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { clock } from "@life/server/src/core/clock";
import { lifePeopleSnapshot, namingAttempts } from "@lifelog/db/schema";
import { NAMING } from "../src/config";
import {
  namingPolicyHashOf,
  namingPromptHash,
  namingWorkHash,
} from "../src/inferred-speakers";
import { readNamingInputs } from "../src/naming-pass";
import { seedConversation, testDb } from "../src/testing";
import { freezeNamingCase, readNamingEvaluation } from "./eval-voices";

test("frozen queue receipts select exact windows and score newly created canonical Life identities", () => {
  const env = testDb();
  try {
    const at = clock().getTime() + 86_400_000;
    env.db
      .insert(lifePeopleSnapshot)
      .values({
        folds: {},
        hash: "independent-identities",
        people: [
          {
            aliases: [],
            name: "Guest",
            personId: null,
            ref: "person:guest",
          },
        ],
        revision: 1,
      })
      .run();
    const held = seedConversation(
      env.db,
      Array.from({ length: NAMING.contextMaxScopes + 3 }, (_, index) => ({
        end: index * 2 + 1,
        speakerId: "s",
        start: index * 2,
        text: "Hello Guest.",
      })),
      { at: at - 600_000, ms: 600_000 }
    );
    const input = [...readNamingInputs(env.db, held.id)].at(1);
    assert(input);
    const metadata = {
      calibration: {
        confidence: 0.98,
        contradictionMargin: 0.15,
        contradictionScore: 0.65,
      },
      model: "synthetic-codex",
      policyHash: namingPolicyHashOf(),
      promptHash: namingPromptHash(),
      snapshots: {},
    };
    const attemptId = "synthetic-window";
    const readings = input.scopes.map((scope) => ({
      confidence: 0.99,
      evidence: [{ quote: "Hello Guest.", turn: 0 }],
      personId: "life:person:guest",
      scopeId: scope.id,
    }));
    env.db
      .insert(namingAttempts)
      .values({
        call: {
          inputTokens: 10,
          outputTokens: 10,
          text: JSON.stringify({ readings }),
        },
        conversationId: held.id,
        id: attemptId,
        inputHash: namingWorkHash(input.inputHash, metadata.model),
        model: metadata.model,
        policyHash: metadata.policyHash,
        promptHash: metadata.promptHash,
        snapshotRevision: input.snapshotRevision,
        state: "named",
      })
      .run();
    const frozen = freezeNamingCase(env.db, metadata, {
      answers: input.scopes.flatMap((scope) =>
        scope.turnIndices.map((turnIndex) => ({
          jobId: scope.jobId,
          personId: "life:person:guest",
          speakerLabel: scope.speakerLabel,
          turnIndex,
        }))
      ),
      at,
      attemptId,
      conversationId: held.id,
      identityEvidence: [
        { at: at - 1_000_000, personId: "life:person:guest", recordingIds: [] },
      ],
      partition: "held-out",
    });
    expect(frozen.inputHash).toBe(input.inputHash);
    expect(frozen.input?.scopes).toEqual(input.scopes);
    const report = readNamingEvaluation({
      ...metadata,
      calibration: {
        confidence: 0.98,
        contradictionMargin: 0.15,
        contradictionScore: 0.65,
      },
      cases: [frozen],
    });
    expect(
      readNamingEvaluation({ ...metadata, cases: [frozen] }).overall
    ).toEqual(report.overall);
    expect(report.overall).toMatchObject({
      correct: input.scopes.length,
      predictions: input.scopes.length,
    });
  } finally {
    env.drop();
  }
});
