// A read of the naming queue, projected per embedding model. The queue owns eligibility,
// order, words and clips; speakers.ts owns every likeness and margin. Nothing is written.
import type { Db } from "@lifelog/db";
import {
  speakerAssignments as assignments,
  people,
  turns,
  voiceSamples,
} from "@lifelog/db/schema";
import { and, desc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  NAMING,
  RECOGNITION,
  VOICE_MAP_POINTS_PER_PERSON_MODEL,
} from "./config";
import type { Card } from "./naming-queue";
import { personRow } from "./people";
import { coveredByRow, modelKey, ofItsSpeaker } from "./recognized-rows";
import { readProfiles } from "./speaker-recognition";
import { centroid, rankPeople } from "./speakers";
import { readInference, readTurnText } from "./transcript-visibility";
import { pcaOf } from "./voice-pca";
import type { Vector } from "./voice-vectors";

export const VOICE_SCOPES = ["speaker", "turns"] as const;
export type VoiceScope = (typeof VOICE_SCOPES)[number];

export function readVoiceProjection(
  db: Db,
  shown: {
    card: Card & { scope: VoiceScope };
    samples: (typeof voiceSamples.$inferSelect)[];
  }[],
  profiles = readProfiles(db)
) {
  const partition = sql`partition by ${assignments.personId}, ${voiceSamples.modelId}, ${voiceSamples.modelRevision}`;
  const ranked = db.$with("named_samples").as(
    db
      .select({
        basis: assignments.source,
        id: voiceSamples.id,
        ordinal:
          sql<number>`row_number() over (${partition} order by coalesce(${turns.startAt}, ${voiceSamples.createdAt}), ${voiceSamples.id})`.as(
            "ordinal"
          ),
        personId: assignments.personId,
        total: sql<number>`count(*) over (${partition})`.as("total"),
      })
      .from(voiceSamples)
      .innerJoin(assignments, coveredByRow)
      .leftJoin(
        turns,
        and(
          eq(turns.jobId, voiceSamples.jobId),
          eq(turns.turnIndex, voiceSamples.turnIndex)
        )
      )
      .where(
        and(
          eq(assignments.status, "person"),
          isNotNull(assignments.personId),
          isNull(assignments.candidates)
        )
      )
  );
  const intervals = VOICE_MAP_POINTS_PER_PERSON_MODEL - 1;
  // Rank metadata first: decode embeddings only at floor(i * (total - 1) / intervals).
  const named = db
    .with(ranked)
    .select({
      basis: ranked.basis,
      personId: ranked.personId,
      sample: voiceSamples,
    })
    .from(ranked)
    .innerJoin(voiceSamples, eq(voiceSamples.id, ranked.id))
    .where(
      or(
        lte(ranked.total, VOICE_MAP_POINTS_PER_PERSON_MODEL),
        eq(ranked.ordinal, ranked.total),
        sql`cast((${ranked.ordinal} * ${intervals} + ${ranked.total} - 2) / (${ranked.total} - 1) as integer)
        > cast(((${ranked.ordinal} - 1) * ${intervals} + ${ranked.total} - 2) / (${ranked.total} - 1) as integer)`
      )
    )
    .orderBy(sql`${ranked.ordinal}`, voiceSamples.id)
    .all();
  const groups = shown.flatMap(({ card, samples: members }) =>
    [...Map.groupBy(members, modelKey)].map(([model, inModel]) => ({
      id: card.id,
      model,
      vector: centroid(inModel.map((s) => s.embedding)),
      words: card.words,
    }))
  );
  const models = [
    ...new Set([
      ...profiles.keys(),
      ...groups.map((g) => g.model),
      ...named.map((r) => modelKey(r.sample)),
    ]),
  ].map((model) => {
    const known = profiles.get(model)?.people ?? [];
    const points: {
      basis: "owner" | "recognized" | "inferred" | null;
      kind: "centroid" | "sample" | "unnamed";
      id: string;
      personId: string | null;
      ranking: { personId: string; score: number; margin: number }[];
      vector: Vector;
      words: number;
    }[] = [
      ...known.map((p) => ({
        basis: null,
        id: p.personId,
        kind: "centroid" as const,
        personId: p.personId,
        ranking: [],
        vector: centroid(p.exemplars),
        words: 0,
      })),
      ...groups
        .filter((g) => g.model === model)
        .map((g) => ({
          basis: null,
          id: g.id,
          kind: "unnamed" as const,
          personId: null,
          ranking: rankPeople(g.vector, known).map(
            ({ personId, score, margin }) => ({ margin, personId, score })
          ),
          vector: g.vector,
          words: g.words,
        })),
    ];
    const fit = points.map((p) => p.vector);
    points.push(
      ...named
        .filter((r) => modelKey(r.sample) === model)
        .map((row) => ({
          basis: row.basis,
          id: row.sample.id,
          kind: "sample" as const,
          personId: row.personId,
          ranking: [],
          vector: row.sample.embedding,
          words: 0,
        }))
    );
    // Few centroids give fewer independent axes: clouds cannot show variation outside that fit.
    const positions = pcaOf(
      fit,
      points.map((p) => p.vector)
    );
    return {
      model,
      points: positions.map((position, i) => {
        const paired = points[i];
        if (!paired) {
          throw new Error("PCA position has no voice point");
        }
        const { vector: _, ...point } = paired;
        return { ...point, position };
      }),
    };
  });
  return {
    candidateThreshold: RECOGNITION.candidateThreshold,
    cards: shown.map(({ card }) => card),
    inferred: db
      .select({
        inference: assignments.inference,
        jobId: turns.jobId,
        personId: people.id,
        personName: people.name,
        speakerLabel: assignments.speakerLabel,
        turnIndex: turns.turnIndex,
      })
      .from(turns)
      .innerJoin(
        assignments,
        and(
          eq(assignments.jobId, turns.jobId),
          eq(assignments.speakerLabel, turns.speakerLabel),
          or(
            eq(assignments.turnIndex, turns.turnIndex),
            and(
              isNull(assignments.turnIndex),
              ofItsSpeaker(turns.jobId, turns.turnIndex)
            )
          )
        )
      )
      .innerJoin(people, eq(people.id, assignments.personId))
      .where(eq(assignments.source, "inferred"))
      .orderBy(desc(turns.startAt), turns.jobId, turns.turnIndex)
      .limit(NAMING.inferredMaxTurns)
      .all()
      .flatMap((inferred) => {
        const text = readTurnText(db, inferred.jobId, inferred.turnIndex);
        return text === null
          ? []
          : [
              {
                ...inferred,
                inference: readInference(db, inferred.inference),
                text,
              },
            ];
      }),
    models,
    people: db.select().from(people).all().map(personRow),
  };
}
