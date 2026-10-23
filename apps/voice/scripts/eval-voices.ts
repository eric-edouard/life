// The ground truth for who spoke inside a voice: every turn with a voice sample and an owner's
// answer, for the turn itself or for its voice. Each answered voice is replayed through `match` as
// if unanswered, with profiles rebuilt without its conversation, and scored against his answers.
// It measures `match` alone, on a first pass: no nearby voices, no several-people candidates, and
// every sample of a voice (production leaves out turns with their own row). Run it before and
// after a change to `match`, `decide` or `weighProfiles`, on the same export. The export holds his
// voice: keep it out of the repo.
//   DATABASE_PATH=<the archive> bun run --cwd apps/voice eval:voices export > <outside the repo>/voices.json
//   bun run --cwd apps/voice eval:voices <outside the repo>/voices.json

import { connect, type Db } from "@life/voice-db";
import {
  people,
  speakerAssignments,
  voiceSamples,
} from "@life/voice-db/schema";
import { eq } from "drizzle-orm";
import {
  evidenceRows,
  match,
  speakerOf,
  voiceId,
  weighProfiles,
} from "../src/people";
import { cosine } from "../src/speakers";

export type Export = ReturnType<typeof exportVoices>;
type Sample = Export["samples"][number];

const OUTCOMES = [
  "ownerRight",
  "ownerMissed",
  "otherRight",
  "nobodyRight",
  "falseOwner",
  "wrongPerson",
  "leftUnnamed",
] as const;
type Outcome = (typeof OUTCOMES)[number];

const voiceOf = (s: Sample) => voiceId(s.jobId, s.speakerLabel);

// Who he said spoke a sampled turn, by the one read rule (`speakerOf`): his answer for the turn,
// else for its voice. A row of several people names a fallback, not who spoke. A null answer is
// "don't know" or media: nobody he knows.
function answers(data: Export) {
  const byJob = Map.groupBy(
    data.assignments.filter((a) => !a.candidates),
    (a) => a.jobId
  );
  return (s: Sample) =>
    speakerOf(byJob.get(s.jobId), s.speakerLabel, s.turnIndex)?.personId;
}

function outcome(
  owner: string,
  truth: string | null,
  said: string | null
): Outcome {
  if (truth === owner) {
    return said === owner ? "ownerRight" : "ownerMissed";
  }
  if (said === truth) {
    return truth ? "otherRight" : "nobodyRight";
  }
  if (said === owner) {
    return "falseOwner";
  }
  return said ? "wrongPerson" : "leftUnnamed";
}

type Profiles = ReturnType<typeof weighProfiles>;

// One answered voice replayed: each judged turn's outcome, his cosine for each turn inside a voice
// recognized as him, and whether the voice holds him, him and another, and was credited to him.
function scoreVoice(
  owner: string,
  judged: { s: Sample; truth: string | null }[],
  voice: Sample[],
  profiles: Profiles
) {
  const r = match(voice, profiles);
  const ownerVector = profiles
    .get(r.model ?? "")
    ?.find((p) => p.isOwner)?.vector;
  const credited = r.personId === owner;
  const holdsHim = judged.some((j) => j.truth === owner);
  return {
    another: holdsHim && judged.some((j) => j.truth !== owner),
    credited,
    holdsHim,
    turns: judged.map(({ s, truth }) => {
      const turn = r.turns.find((t) => t.turnIndex === s.turnIndex);
      return {
        cosine:
          credited && ownerVector ? cosine(s.embedding, ownerVector) : null,
        his: truth === owner,
        outcome: outcome(owner, truth, turn ? turn.personId : r.personId),
      };
    }),
  };
}

// Every answered voice, each conversation's against profiles rebuilt without it.
function replay(data: Export) {
  const truthOf = answers(data);
  const { evidence } = data;
  // A job is judged without the evidence of any conversation its samples were cut in: a sample
  // keeps the conversation it was cut for, and a job's can differ.
  return [...Map.groupBy(data.samples, (s) => s.jobId).values()].flatMap(
    (inJob) => {
      const own = new Set(inJob.map((s) => s.conversationId));
      const profiles = weighProfiles(
        evidence.filter((e) => !own.has(e.conversationId))
      );
      return [...Map.groupBy(inJob, voiceOf).values()].flatMap((voice) => {
        const judged = voice.flatMap((s) => {
          const truth = truthOf(s);
          return truth === undefined ? [] : [{ s, truth }];
        });
        return judged.length > 0
          ? [scoreVoice(data.owner, judged, voice, profiles)]
          : [];
      });
    }
  );
}

export function evaluate(data: Export) {
  const voices = replay(data);
  const turns = voices.flatMap((v) => v.turns);
  const counts = Object.fromEntries(
    OUTCOMES.map((o) => [o, turns.filter((t) => t.outcome === o).length])
  ) as Record<Outcome, number>;
  const inside = (his: boolean) =>
    turns.flatMap((t) =>
      t.cosine !== null && t.his === his ? [t.cosine] : []
    );
  return {
    // Voices holding his voice, those also holding another voice or nobody he knows, and of those,
    // the ones credited to him.
    clusters: {
      creditedWithAnother: voices.filter((v) => v.another && v.credited).length,
      holdingHim: voices.filter((v) => v.holdsHim).length,
      holdingHimAndAnother: voices.filter((v) => v.another).length,
    },
    counts,
    // His cosine, per turn inside a voice recognized as him: his own turns and the others'.
    insideHim: { his: inside(true), others: inside(false) },
    turns: turns.length,
  };
}

// What the eval reads, read-only, inside the server's container: voices and his answers, never a
// transcript's text.
export function exportVoices(db: Db) {
  // One snapshot (the script opens the file read-only).
  return db.transaction((tx) => {
    const owner = tx
      .select({ id: people.id })
      .from(people)
      .where(eq(people.isOwner, true))
      .get();
    if (!owner) {
      throw new Error("no owner");
    }
    return {
      assignments: tx
        .select({
          candidates: speakerAssignments.candidates,
          jobId: speakerAssignments.jobId,
          personId: speakerAssignments.personId,
          speakerLabel: speakerAssignments.speakerLabel,
          turnIndex: speakerAssignments.turnIndex,
        })
        .from(speakerAssignments)
        .where(eq(speakerAssignments.source, "owner"))
        .all(),
      evidence: evidenceRows(tx),
      owner: owner.id,
      samples: tx
        .select({
          conversationId: voiceSamples.conversationId,
          durationSeconds: voiceSamples.durationSeconds,
          embedding: voiceSamples.embedding,
          id: voiceSamples.id,
          jobId: voiceSamples.jobId,
          modelId: voiceSamples.modelId,
          modelRevision: voiceSamples.modelRevision,
          speakerLabel: voiceSamples.speakerLabel,
          turnIndex: voiceSamples.turnIndex,
        })
        .from(voiceSamples)
        .all(),
    };
  });
}

const quantiles = (xs: number[]) => {
  const sorted = xs.toSorted((a, b) => a - b);
  return [0.1, 0.25, 0.5, 0.75, 0.9].map((q) =>
    (sorted[Math.floor(q * (sorted.length - 1))] ?? Number.NaN).toFixed(2)
  );
};

if (import.meta.main) {
  const [command] = Bun.argv.slice(2);
  if (command === "export") {
    const url = process.env.DATABASE_PATH;
    if (!url) {
      throw new Error("DATABASE_PATH is not set");
    }
    console.log(JSON.stringify(exportVoices(connect(url, { readonly: true }))));
    process.exit(0);
  } else if (command) {
    const { clusters, counts, insideHim, turns } = evaluate(
      await Bun.file(command).json()
    );
    console.log(JSON.stringify({ clusters, counts, turns }, null, 2));
    console.log("his cosine inside his voices, 10/25/50/75/90%:");
    console.log(
      `  his turns (${insideHim.his.length})`,
      quantiles(insideHim.his).join(" ")
    );
    console.log(
      `  others' (${insideHim.others.length})`,
      quantiles(insideHim.others).join(" ")
    );
  }
}
