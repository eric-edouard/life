// A read of the naming queue, projected per embedding model. The queue owns eligibility,
// order, words and clips; speakers.ts owns every likeness and margin. Nothing is written.
import type { Db } from "@lifelog/db";
import {
  people,
  speakerAssignments,
  transcriptionJobs,
  voiceSamples,
} from "@lifelog/db/schema";
import { RECOGNITION } from "./config";
import { clipOf } from "./naming-clips";
import type { QueueItems } from "./naming-queue";
import {
  holdingConversations,
  modelKey,
  personRow,
  readProfiles,
  voiceId,
} from "./people";
import { centroid, rankPeople } from "./speakers";
import { loadTurns } from "./transcript";
import { pcaOf } from "./voice-pca";
import type { Vector } from "./voice-vectors";

export function readVoiceMap(db: Db, cards: QueueItems) {
  const profiles = readProfiles(db);
  const samples = db.select().from(voiceSamples).all();
  const rows = db.select().from(speakerAssignments).all();
  const turns = new Set(
    rows
      .filter((r) => r.turnIndex !== null)
      .map((r) => `${r.jobId}/${r.turnIndex}`)
  );
  const split = readSplitCards(db, rows);
  const shown = [...cards, ...split];
  const byVoice = Map.groupBy(
    samples.filter((s) => !turns.has(`${s.jobId}/${s.turnIndex}`)),
    (s) => voiceId(s.jobId, s.speakerLabel)
  );
  const byTurn = Map.groupBy(samples, (s) => `${s.jobId}/${s.turnIndex}`);
  const groups = shown.flatMap((card) => {
    const members = card.id.startsWith("turns/")
      ? card.clips.flatMap((c) => byTurn.get(`${c.jobId}/${c.turnIndex}`) ?? [])
      : card.voices.flatMap(
          (v) => byVoice.get(voiceId(v.jobId, v.speakerLabel)) ?? []
        );
    return [...Map.groupBy(members, modelKey)].map(([model, inModel]) => ({
      id: card.id,
      model,
      vector: centroid(inModel.map((s) => s.embedding)),
      words: card.words,
    }));
  });
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
    cards: shown,
    models,
    people: db.select().from(people).all().map(personRow),
  };
}

// Split groups have no phone card: the map names their stored turns through the existing PUT.
function readSplitCards(
  db: Db,
  rows: (typeof speakerAssignments.$inferSelect)[]
) {
  const loaded = new Map<string, ReturnType<typeof loadTurns>>();
  const split = rows.filter(
    (r) =>
      r.source === "recognized" &&
      r.turnIndex !== null &&
      r.candidateId &&
      !r.personId
  );
  if (split.length === 0) {
    return [];
  }
  const jobs = new Map(
    db
      .select({
        id: transcriptionJobs.id,
        map: transcriptionJobs.map,
        objectKey: transcriptionJobs.objectKey,
      })
      .from(transcriptionJobs)
      .all()
      .map((j) => [j.id, j])
  );
  const conversations = new Map(
    [...new Set(split.map((r) => r.jobId))].map((jobId) => [
      jobId,
      holdingConversations(db, jobId),
    ])
  );
  return [...Map.groupBy(split, (r) => r.candidateId)].flatMap(
    ([group, members]) => {
      let words = 0;
      let seconds = 0;
      const clips = members.flatMap((r) => {
        for (const id of conversations.get(r.jobId) ?? []) {
          if (!loaded.has(id)) {
            loaded.set(id, loadTurns(db, id));
          }
          const turn = loaded
            .get(id)
            ?.turns.find(
              (t) => t.ref.jobId === r.jobId && t.ref.turnIndex === r.turnIndex
            );
          if (turn) {
            words += turn.words.length;
            seconds += turn.endSeconds - turn.startSeconds;
            const job = jobs.get(r.jobId);
            return [clipOf(id, turn, job?.objectKey ? job.map : null)];
          }
        }
        return [];
      });
      return clips.length
        ? [
            {
              clips,
              conversations: new Set(clips.map((c) => c.conversationId)).size,
              evidence: [],
              exchanges: 0,
              id: `turns/${group}`,
              kind: "new_person" as const,
              name: null,
              personId: null,
              seconds: Math.round(seconds),
              voices: [
                ...new Map(
                  clips.map((c) => [
                    `${c.jobId}/${c.speakerLabel}`,
                    {
                      conversationId: c.conversationId,
                      jobId: c.jobId,
                      speakerLabel: c.speakerLabel ?? "",
                    },
                  ])
                ).values(),
              ],
              words,
            },
          ]
        : [];
    }
  );
}
