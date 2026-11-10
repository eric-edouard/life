// The ground truth for who spoke inside a voice: every turn with a voice sample and an owner's
// answer, for the turn itself or for its voice. Each answered voice is replayed through `match` as
// if unanswered, with profiles rebuilt without its conversation, and scored against his answers.
// It measures `match` alone, on a first pass: no nearby voices, no several-people candidates, and
// every sample of a voice (production leaves out turns with their own row).
// His answered voices are frozen once in one file beside the archive, never in the repo (it holds
// his voice); the replay's counts are committed in `fixtures/voice-eval-baseline.json`, and the
// gate (`--check`) fails when a change moves them, on the same file. A change to `match`, `decide`
// or `weighProfiles` rewrites the baseline, so the PR shows its effect.
//   DATABASE_PATH=<the archive> bun run --cwd apps/lifelog/apps/server eval:voices export   # freeze his answers again, then as below
//   bun run --cwd apps/lifelog/apps/server eval:voices             # replay, print, rewrite the baseline
//   bun run --cwd apps/lifelog/apps/server eval:voices --check     # the gate

import { join } from "node:path";
import { sha256Of } from "@life/server/src/core/hash";
import { APP_DATA } from "@life/server/src/core/platform";
import { connect, type Db } from "@lifelog/db";
import { people, speakerAssignments, voiceSamples } from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import {
  evidenceRows,
  match,
  type ProfilesByModel,
  speakerOf,
  strangerRows,
  voiceId,
  weighProfiles,
} from "../src/people";
import { recheckOf } from "../src/recheck";
import { likeness, profilesWithout } from "../src/speakers";

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

// His answer for a sampled turn, by the one read rule (`speakerOf`): for the turn, else for its
// voice; none when he never answered, or answered several people (a fallback, not who spoke). A
// row without a person is "Not anyone I know" or media (its `status`): nobody he knows.
export function answers(data: Pick<Export, "assignments">) {
  const byJob = Map.groupBy(data.assignments, (a) => a.jobId);
  return (s: Pick<Sample, "jobId" | "speakerLabel" | "turnIndex">) => {
    const row = speakerOf(byJob.get(s.jobId), s.speakerLabel, s.turnIndex);
    return row?.candidates ? undefined : row;
  };
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

// One answered voice replayed: each judged turn's outcome, his likeness for each turn inside a voice
// recognized as him, and whether the voice holds him, him and another, and was credited to him.
function scoreVoice(
  owner: string,
  judged: { s: Sample; truth: string | null }[],
  voice: Sample[],
  profiles: ProfilesByModel
) {
  const r = match(voice, profiles);
  const ownerProfile = profiles
    .get(r.model ?? "")
    ?.people.find((p) => p.isOwner);
  const credited = r.personId === owner;
  const holdsHim = judged.some((j) => j.truth === owner);
  return {
    another: holdsHim && judged.some((j) => j.truth !== owner),
    credited,
    holdsHim,
    turns: judged.map(({ s, truth }) => {
      const turn = r.turns.find((t) => t.turnIndex === s.turnIndex);
      return {
        his: truth === owner,
        likeness:
          credited && ownerProfile
            ? likeness(s.embedding, ownerProfile.exemplars)
            : null,
        outcome: outcome(owner, truth, turn ? turn.personId : r.personId),
      };
    }),
  };
}

// Every model's profiles, to judge a job without any conversation its samples were cut in
// (speakers.ts `profilesWithout`): a sample keeps the conversation it was cut for, and a job's can differ.
export function profilesOf({
  evidence,
  strangers,
}: Pick<Export, "evidence" | "strangers">) {
  const all = weighProfiles(evidence, strangers);
  return (conversations: Set<string>): ProfilesByModel =>
    new Map(
      [...all].map(([m, p]) => [m, profilesWithout(p, conversations)] as const)
    );
}

// Every answered voice, each conversation's against profiles rebuilt without it.
function replay(data: Export) {
  const answerOf = answers(data);
  const without = profilesOf(data);
  const all = without(new Set());
  return [...Map.groupBy(data.samples, (s) => s.jobId).values()].flatMap(
    (inJob) => {
      const profiles = without(new Set(inJob.map((s) => s.conversationId)));
      return [...Map.groupBy(inJob, voiceOf).values()].flatMap((voice) => {
        const judged = voice.flatMap((s) => {
          const answer = answerOf(s);
          return answer ? [{ s, truth: answer.personId }] : [];
        });
        const own = voice.filter((s) => answerOf(s)?.turnIndex === null);
        const namedPersonId = own[0] && answerOf(own[0])?.personId;
        return judged.length > 0
          ? [
              {
                ...scoreVoice(data.owner, judged, voice, profiles),
                recheck: !!(
                  namedPersonId &&
                  recheckOf(
                    own,
                    namedPersonId,
                    all,
                    new Set(own.map((s) => s.conversationId))
                  )
                ),
              },
            ]
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
      t.likeness !== null && t.his === his ? [t.likeness] : []
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
    // His likeness, per turn inside a voice recognized as him: his own turns and the others'.
    insideHim: { his: inside(true), others: inside(false) },
    rechecks: voices.filter((v) => v.recheck).length,
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
          status: speakerAssignments.status,
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
      strangers: strangerRows(tx),
    };
  });
}

const quantiles = (xs: number[]) => {
  const sorted = xs.toSorted((a, b) => a - b);
  return [0.1, 0.25, 0.5, 0.75, 0.9].map((q) =>
    (sorted[Math.floor(q * (sorted.length - 1))] ?? Number.NaN).toFixed(2)
  );
};

const ANSWERED = join(APP_DATA, "lifelog", "answered-voices.json");
const BASELINE = `${import.meta.dir}/../fixtures/voice-eval-baseline.json`;

if (import.meta.main) {
  if (Bun.argv.includes("export")) {
    const url = process.env.DATABASE_PATH;
    if (!url) {
      throw new Error("DATABASE_PATH is not set");
    }
    await Bun.write(
      ANSWERED,
      JSON.stringify(exportVoices(connect(url, { readonly: true })))
    );
  }
  if (!(await Bun.file(ANSWERED).exists())) {
    console.log(`voice eval: skipped, no ${ANSWERED}`);
    process.exit(0);
  }
  const answered = await sha256Of(ANSWERED);
  const { clusters, counts, insideHim, rechecks, turns } = evaluate(
    await Bun.file(ANSWERED).json()
  );
  const result = { answered, clusters, counts, rechecks, turns };
  if (Bun.argv.includes("--check")) {
    const baseline = await Bun.file(BASELINE).json();
    // His answers frozen again on another branch: that branch's baseline judges them.
    if (baseline.answered !== answered) {
      console.log(
        "voice eval: skipped, the baseline was made from other answers"
      );
    } else if (JSON.stringify(baseline) !== JSON.stringify(result)) {
      console.error(
        `voice eval: the replay moved; run eval:voices to rewrite the baseline\nbefore ${JSON.stringify(baseline)}\nafter  ${JSON.stringify(result)}`
      );
      process.exit(1);
    }
    process.exit(0);
  }
  await Bun.write(BASELINE, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ clusters, counts, rechecks, turns }, null, 2));
  console.log("his likeness inside his voices, 10/25/50/75/90%:");
  console.log(
    `  his turns (${insideHim.his.length})`,
    quantiles(insideHim.his).join(" ")
  );
  console.log(
    `  others' (${insideHim.others.length})`,
    quantiles(insideHim.others).join(" ")
  );
}
