// Who a speaker sounds like, against the people's profiles: the names a card offers, closest
// first, and whether a name he gave is a recheck.
import type { Db } from "@lifelog/db";
import {
  speakerAssignments as assignments,
  conversations as conversationRows,
  turns,
  voiceSamples,
} from "@lifelog/db/schema";
import { and, gt, gte, inArray, isNull, lt } from "drizzle-orm";
import { RECOGNITION } from "./config";
import {
  ofItsSpeaker,
  type ProfilesByModel,
  readProfiles,
  speakerVoice,
  voiceId,
} from "./people";
import {
  NO_PROFILES,
  profilesWithout,
  rankPeople,
  soundsLikeOf,
} from "./speakers";

// Whether a speaker he named is a recheck, from its own samples: one model's, against that
// model's profiles without `conversations`. The queue and the voice eval read this.
export function recheckOf(
  samples: Parameters<typeof speakerVoice>[0],
  namedPersonId: string,
  profiles: ProfilesByModel,
  conversations: Set<string>
) {
  const voice = speakerVoice(samples);
  return soundsLikeOf(
    voice.samples.map((s) => s.embedding),
    namedPersonId,
    profilesWithout(profiles.get(voice.model) ?? NO_PROFILES, conversations)
      .people
  );
}

// Everyone, the most like the speaker first; none when it is too short to judge.
// Only an order for his names, so its own conversations count (a recheck judges without them).
export function likelyOf(
  samples: Parameters<typeof speakerVoice>[0],
  profiles: ProfilesByModel
) {
  const voice = speakerVoice(samples);
  return voice.vector
    ? rankPeople(
        voice.vector,
        (profiles.get(voice.model) ?? NO_PROFILES).people
      ).map((p) => p.personId)
    : [];
}

// How many people a voice's likeness names.
const LIKENESS_PEOPLE = 2;

// For `GET /speakers/voices`: every speaker label of the jobs with a turn starting in [from, to),
// who answered it, and whom it sounds like. Read-only. Profiles are read once for the whole call
// (every evidence clip: the one costly step); a label is ranked without the exemplars of the
// conversations over the span and of its own samples, so a voice never meets itself.
export function readSpeakerVoices(db: Db, from: Date, to: Date) {
  const labels = db
    .selectDistinct({ jobId: turns.jobId, speakerLabel: turns.speakerLabel })
    .from(turns)
    .where(and(gte(turns.startAt, from), lt(turns.startAt, to)))
    .all()
    .flatMap((t) =>
      t.speakerLabel === null ? [] : [{ jobId: t.jobId, label: t.speakerLabel }]
    );
  if (labels.length === 0) {
    return [];
  }
  const jobIds = [...new Set(labels.map((l) => l.jobId))];
  const rows = new Map(
    db
      .select()
      .from(assignments)
      .where(
        and(inArray(assignments.jobId, jobIds), isNull(assignments.turnIndex))
      )
      .all()
      .map((r) => [voiceId(r.jobId, r.speakerLabel), r] as const)
  );
  const samples = Map.groupBy(
    db
      .select()
      .from(voiceSamples)
      .where(
        and(
          inArray(voiceSamples.jobId, jobIds),
          ofItsSpeaker(voiceSamples.jobId, voiceSamples.turnIndex)
        )
      )
      .all(),
    (s) => voiceId(s.jobId, s.speakerLabel)
  );
  // The live conversations over the span (a query per job through `conversation_jobs` took 3 ms each).
  const spans = new Set(
    db
      .select({ id: conversationRows.id })
      .from(conversationRows)
      .where(
        and(
          lt(conversationRows.captureStartedAt, to),
          gt(conversationRows.captureEndedAt, from),
          isNull(conversationRows.retiredAt)
        )
      )
      .all()
      .map((c) => c.id)
  );
  const profiles = readProfiles(db);
  return labels
    .map(({ jobId, label }) => {
      const key = voiceId(jobId, label);
      const row = rows.get(key);
      const own = samples.get(key) ?? [];
      const voice = speakerVoice(own);
      const without = new Set([...spans, ...own.map((s) => s.conversationId)]);
      const likeness = voice.vector
        ? rankPeople(
            voice.vector,
            profilesWithout(profiles.get(voice.model) ?? NO_PROFILES, without)
              .people
          )
            .filter((p) => p.score >= RECOGNITION.likenessThreshold)
            .slice(0, LIKENESS_PEOPLE)
            .map((p) => ({ personId: p.personId, score: p.score }))
        : [];
      const basis = basisOf(row);
      return {
        basis,
        jobId,
        likeness,
        mixed: Boolean(row?.mixed || row?.candidates),
        personId: row?.personId ?? null,
        speakerLabel: label,
        status: row?.status ?? null,
      };
    })
    .sort((a, b) =>
      voiceId(a.jobId, a.speakerLabel).localeCompare(
        voiceId(b.jobId, b.speakerLabel)
      )
    );
}

// Who named a label: the owner, or lifelog by sound (a person); otherwise nobody.
function basisOf(row: { personId: string | null; source: string } | undefined) {
  if (row?.source === "owner") {
    return "owner" as const;
  }
  return row?.source === "recognized" && row.personId
    ? ("recognized" as const)
    : null;
}
