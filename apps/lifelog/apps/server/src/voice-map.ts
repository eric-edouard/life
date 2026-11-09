// A read of the naming queue, projected per embedding model. The queue owns eligibility,
// order, words and clips; speakers.ts owns every likeness and margin. Nothing is written.
import type { Db } from "@lifelog/db";
import { people } from "@lifelog/db/schema";
import { RECOGNITION } from "./config";
import type { QueueCache } from "./naming-queue";
import { modelKey, personRow, readProfiles, samplesOf } from "./people";
import { centroid, rankPeople, type Vector } from "./speakers";
import { pcaOf } from "./voice-pca";

export function readVoiceMap(db: Db, cards: ReturnType<QueueCache["items"]>) {
  const profiles = readProfiles(db);
  const groups = cards.flatMap((card) =>
    [...Map.groupBy(samplesOf(db, card.voices), modelKey)].map(
      ([model, samples]) => ({
        id: card.id,
        model,
        vector: centroid(samples.map((s) => s.embedding)),
        words: card.words,
      })
    )
  );
  const models = [
    ...new Set([...profiles.keys(), ...groups.map((g) => g.model)]),
  ].map((model) => {
    const known = profiles.get(model)?.people ?? [];
    const points: {
      id: string;
      personId: string | null;
      ranking: { personId: string; score: number; margin: number }[];
      vector: Vector;
      words: number;
    }[] = [
      ...known.map((p) => ({
        id: p.personId,
        personId: p.personId,
        ranking: [],
        vector: centroid(p.exemplars),
        words: 0,
      })),
      ...groups
        .filter((g) => g.model === model)
        .map((g) => ({
          id: g.id,
          personId: null,
          ranking: rankPeople(g.vector, known).map(
            ({ personId, score, margin }) => ({ margin, personId, score })
          ),
          vector: g.vector,
          words: g.words,
        })),
    ];
    const positions = pcaOf(points.map((p) => p.vector));
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
    cards,
    models,
    people: db.select().from(people).all().map(personRow),
  };
}
