// Owner corrections alone create voice evidence.
// biome-ignore lint/performance/noBarrelFile: preserve the public speaker read while sharing its one rule with reconciliation.
export { speakerOf } from "./recognized-rows";

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  speakerAssignments as assignments,
  type Candidates,
  lifePeopleSnapshot,
  namingAttempts,
  type ParsedTranscript,
  people,
  transcripts,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { logChange } from "./change-log";
import { ownerClock, RECOGNITION } from "./config";
import { reportError } from "./diagnostics";
import { type Fields, record, recordedOn } from "./events";
import {
  coveredByRow,
  holdingConversations,
  loadTranscript,
  speakerOf,
} from "./recognized-rows";
import {
  expire,
  readProfiles,
  recognizeJob,
  sweep,
} from "./speaker-recognition";
import { readInference } from "./transcript-visibility";

type Assignment = typeof assignments.$inferSelect;

// Rejected for sampling or naming, not merely already named: candidates still need their clips.
export const isRejected = (
  assignment: Pick<Assignment, "source" | "status" | "candidates"> | undefined
) =>
  assignment?.status === "stranger" ||
  (assignment?.source === "owner" &&
    !assignment.candidates &&
    (assignment.status === "unknown" || assignment.status === "media"));
type Sample = typeof voiceSamples.$inferSelect;
// ---- Samples ----------------------------------------------------------------

// Why a turn can't be a voice sample, or null when it's clean: a speaker, long enough, no
// overlap with another speaker, no stretched word.
export function uncleanTurn(parsed: ParsedTranscript, index: number) {
  const { turns, words = [] } = parsed;
  const turn = turns[index];
  if (!turn?.speakerId) {
    return "turn has no speaker";
  }
  if (turn.end - turn.start < RECOGNITION.minTurnSeconds) {
    return "turn is too short";
  }
  const overlaps = turns.some(
    (o) =>
      o.speakerId !== turn.speakerId && o.start < turn.end && turn.start < o.end
  );
  if (overlaps) {
    return "turn overlaps another speaker";
  }
  const stretched = words.some(
    (w) =>
      w.start >= turn.start &&
      w.start < turn.end &&
      w.end - w.start > RECOGNITION.maxWordSeconds
  );
  return stretched ? "turn holds a stretched word" : null;
}

// Stores the server's embeddings of a job's clean turns (excerpts.ts) and marks the job cut. A
// turn already sampled, by the phone before the rebuild, keeps its sample.
export const keepServerSamples = (
  db: Db,
  jobId: string,
  samples: (typeof voiceSamples.$inferInsert)[]
) =>
  db.transaction((tx) => {
    const kept =
      samples.length > 0
        ? tx
            .insert(voiceSamples)
            .values(samples)
            .onConflictDoNothing()
            .returning()
            .all()
        : [];
    for (const sample of kept) {
      evidenceForNew(tx, sample);
    }
    tx.update(transcripts)
      .set({ excerptsAt: clock() })
      .where(eq(transcripts.jobId, jobId))
      .run();
    if (kept.length > 0) {
      logChange(tx, "job", jobId);
    }
  });

// New evidence requires the owner's person assignment of the turn or its speaker.
function evidenceForNew(tx: Db, sample: Sample) {
  const owner = speakerOf(
    tx
      .select()
      .from(assignments)
      .where(
        and(
          eq(assignments.jobId, sample.jobId),
          eq(assignments.source, "owner")
        )
      )
      .all(),
    sample.speakerLabel,
    sample.turnIndex
  );
  if (owner?.personId && !owner.candidates) {
    setEvidence(tx, [sample.id], owner.personId);
  }
}

function setEvidence(db: Db, sampleIds: string[], personId: string | null) {
  if (sampleIds.length === 0) {
    return;
  }
  db.delete(voiceProfiles)
    .where(inArray(voiceProfiles.sampleId, sampleIds))
    .run();
  if (personId) {
    db.insert(voiceProfiles)
      .values(sampleIds.map((sampleId) => ({ personId, sampleId })))
      .run();
  }
}

// ---- Owner actions ----------------------------------------------------------

export type Target =
  | { kind: "person"; personId: string }
  | { id: string; kind: "new"; name: string }
  | { kind: "unknown" }
  | { kind: "media" }
  // Several people (who exist), and the one to fall back on.
  | { candidates: Candidates; kind: "several"; personId: string | null };

// Names, assigns or corrects a speaker (turnIndex null) or a single turn. The evidence
// that came from that scope in this transcript moves to the new person, or is removed
// when the target is unknown. Turns the owner corrected individually keep their own. Every
// caller then calls `voices.soon()`: the sweep re-matches the rest, this transcript included.
export function assign(
  db: Db,
  input: {
    jobId: string;
    speakerLabel: string;
    target: Target;
    turnIndex: number | null;
  }
) {
  const { jobId, speakerLabel, target, turnIndex } = input;
  return db.transaction((tx) => {
    const turns = loadTranscript(tx, jobId)?.parsed.turns ?? [];
    const exists =
      turnIndex === null
        ? turns.some((t) => t.speakerId === speakerLabel)
        : turns[turnIndex]?.speakerId === speakerLabel;
    if (!exists) {
      return {
        error: "not_found" as const,
        message: "no such speaker or turn",
      };
    }
    const personId = resolveTarget(tx, target);
    if (personId === undefined) {
      return { error: "not_found" as const, message: "no such person" };
    }
    if (personId && (target.kind === "person" || target.kind === "new")) {
      tx.update(people)
        .set({ nameSource: "owner" })
        .where(eq(people.id, personId))
        .run();
    }

    writeOwnerRow(tx, {
      ...input,
      candidates: target.kind === "several" ? target.candidates : null,
      media: target.kind === "media",
      personId,
    });
    invalidateNamingAttempts(tx, [jobId], "owner corrected a speaker");
    cleanupInferredPeople(tx);
    logChange(tx, "assignment", jobId);
    if (personId && target.kind === "new") {
      logChange(tx, "person", personId);
    }
    return assignmentRows(tx, eq(assignments.jobId, jobId));
  });
}

// Replaces the owner row for a speaker or turn and moves that scope's evidence in this
// transcript to the person (or drops it: several people are nobody's evidence).
function writeOwnerRow(
  tx: Db,
  scope: {
    candidates: Candidates | null;
    jobId: string;
    media: boolean;
    personId: string | null;
    speakerLabel: string;
    turnIndex: number | null;
  }
) {
  const { candidates, jobId, media, personId, speakerLabel, turnIndex } = scope;
  const scoped = and(
    eq(assignments.jobId, jobId),
    eq(assignments.speakerLabel, speakerLabel),
    turnIndex === null
      ? isNull(assignments.turnIndex)
      : eq(assignments.turnIndex, turnIndex)
  );
  // A whole-label answer also replaces its model-named splits; owner turn answers stay fixed.
  if (turnIndex === null) {
    tx.delete(assignments)
      .where(
        and(
          eq(assignments.jobId, jobId),
          eq(assignments.speakerLabel, speakerLabel),
          eq(assignments.source, "inferred")
        )
      )
      .run();
  }
  tx.delete(assignments).where(scoped).run();
  const [row] = tx
    .insert(assignments)
    .values({
      candidates,
      jobId,
      personId,
      source: "owner",
      speakerLabel,
      status: ownerStatus(personId, media),
      turnIndex,
    })
    .returning({ id: assignments.id })
    .all();
  const samples = tx
    .select({ id: voiceSamples.id })
    .from(voiceSamples)
    .innerJoin(assignments, coveredByRow)
    .where(eq(assignments.id, row?.id ?? ""))
    .all();
  setEvidence(
    tx,
    samples.map((s) => s.id),
    candidates ? null : personId
  );
  if (candidates) {
    // Its turns decided among them now, before the summaries the phone asks for.
    recognizeJob(tx, jobId, readProfiles(tx));
  }
}

const ownerStatus = (personId: string | null, media: boolean) => {
  if (personId) {
    return "person" as const;
  }
  return media ? ("media" as const) : ("unknown" as const);
};

// The person a target names (created for kind "new"), null for unknown or media,
// undefined if the person doesn't exist.
function resolveTarget(db: Db, target: Target) {
  if (target.kind === "unknown" || target.kind === "media") {
    return null;
  }
  if (target.kind === "several") {
    return target.personId;
  }
  if (target.kind === "person") {
    return db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.id, target.personId))
      .get()?.id;
  }
  // The phone chose the id: a replay finds the person made the first time.
  db.insert(people)
    .values({ id: target.id, name: target.name })
    .onConflictDoNothing()
    .run();
  return target.id;
}

// Local names remain authoritative when Life supplies a linked candidate.
export function renamePerson(
  db: Db,
  id: string,
  input: { name?: string; aliases?: string[] }
) {
  return db.transaction((tx) => {
    const old = tx.select().from(people).where(eq(people.id, id)).get();
    if (!old) {
      return null;
    }
    const name = input.name ?? old.name;
    const renamed = tx
      .update(people)
      .set({
        aliases: aliasesOf(name, input.aliases ?? old.aliases),
        name,
        nameSource: "owner",
      })
      .where(eq(people.id, id))
      .returning()
      .get();
    tx.update(namingAttempts)
      .set({
        error: "owner changed a name",
        nextEligibleAt: null,
        result: null,
        state: "failed",
      })
      .run();
    logChange(tx, "person", id);
    return renamed ? personRow(renamed) : null;
  });
}

// Moves every piece of evidence and every assignment of `fromId` to `intoId`, then
// deletes `fromId`. A replay, `fromId` gone and `intoId` there, answers `intoId` as it is.
export function merge(db: Db, intoId: string, fromId: string) {
  return db.transaction((tx) => {
    const found = tx
      .select()
      .from(people)
      .where(inArray(people.id, [intoId, fromId]))
      .all();
    const into = found.find((p) => p.id === intoId);
    const from = found.find((p) => p.id === fromId);
    if (into && !from) {
      return personRow(into);
    }
    if (!(into && from) || intoId === fromId) {
      return null;
    }
    // Transfer the unique link before deleting its old person, inside this transaction.
    if (!into.lifeRef && from.lifeRef) {
      tx.update(people)
        .set({ lifeRef: null })
        .where(eq(people.id, fromId))
        .run();
    }
    const merged = tx
      .update(people)
      .set({
        ...mergedNameOf(into, from),
        isOwner: into.isOwner || from.isOwner,
        lifeRef: into.lifeRef ?? from.lifeRef,
      })
      .where(eq(people.id, intoId))
      .returning()
      .get();
    tx.update(voiceProfiles)
      .set({ personId: intoId })
      .where(eq(voiceProfiles.personId, fromId))
      .run();
    const moved = tx
      .update(assignments)
      .set({ personId: intoId })
      .where(eq(assignments.personId, fromId))
      .returning({ jobId: assignments.jobId })
      .all();
    // A voice of several people holds them under the id they merged into, once.
    const several = tx
      .select({
        candidates: assignments.candidates,
        id: assignments.id,
        jobId: assignments.jobId,
      })
      .from(assignments)
      .where(
        sql`exists (select 1 from json_each(${assignments.candidates}, '$.people') where value = ${fromId})`
      )
      .all();
    for (const { candidates, id } of several) {
      if (!candidates) {
        continue;
      }
      const ids = candidates.people.map((p) => (p === fromId ? intoId : p));
      tx.update(assignments)
        .set({
          candidates: { ...candidates, people: [...new Set(ids)].sort() },
        })
        .where(eq(assignments.id, id))
        .run();
    }
    tx.delete(people).where(eq(people.id, fromId)).run();
    invalidateNamingAttempts(
      tx,
      [...moved, ...several].map((m) => m.jobId),
      "people merged"
    );
    logChange(tx, "person", [intoId, fromId]);
    logChange(
      tx,
      "assignment",
      [...moved, ...several].map((m) => m.jobId)
    );
    return merged ? personRow(merged) : null;
  });
}

// A fold keeps owner names and aliases; an inferred name never becomes an owner alias.
function mergedNameOf(
  into: typeof people.$inferSelect,
  from: typeof people.$inferSelect
) {
  const named =
    into.nameSource === "owner" || from.nameSource !== "owner" ? into : from;
  return {
    aliases: aliasesOf(named.name, [
      ...(into.nameSource === "owner" ? into.aliases : []),
      ...(from.nameSource === "owner" ? from.aliases : []),
      ...(from.nameSource === "owner" ? [from.name] : []),
    ]),
    name: named.name,
    nameSource: named.nameSource,
  };
}

function invalidateNamingAttempts(tx: Db, jobs: string[], error: string) {
  const conversations = [
    ...new Set(jobs.flatMap((jobId) => holdingConversations(tx, jobId))),
  ];
  if (conversations.length > 0) {
    tx.update(namingAttempts)
      .set({ error, nextEligibleAt: null, result: null, state: "failed" })
      .where(inArray(namingAttempts.conversationId, conversations))
      .run();
  }
}

// Losing an inferred answer never removes recordings, samples or a person the owner has evidenced.
export function cleanupInferredPeople(tx: Db) {
  const removed = tx
    .delete(people)
    .where(
      and(
        eq(people.creationSource, "inferred"),
        eq(people.nameSource, "inferred"),
        sql`not exists (select 1 from ${assignments} a where a.person_id = ${people.id}
      or exists (select 1 from json_each(a.candidates, '$.people') c where c.value = ${people.id}))`,
        sql`not exists (select 1 from ${voiceProfiles} v where v.person_id = ${people.id})`,
        sql`not exists (select 1 from ${lifePeopleSnapshot} s, json_each(s.people) p
      where p.value ->> '$.personId' = ${people.id} or p.value ->> '$.ref' = ${people.lifeRef})`
      )
    )
    .returning({ id: people.id })
    .all();
  logChange(
    tx,
    "person",
    removed.map((p) => p.id)
  );
}

// ---- Reads ------------------------------------------------------------------

// Each job's rows, by job.
export const assignmentsByJob = (db: Db, jobIds: Iterable<string>) =>
  Map.groupBy(
    assignmentRows(db, inArray(assignments.jobId, [...new Set(jobIds)])),
    (r) => r.jobId
  );

// Who each speaker or turn is, as the feed and the routes send it.
export function assignmentRows(db: Db, where: SQL | undefined) {
  const rows = db
    .select({ assignment: assignments, personName: people.name })
    .from(assignments)
    .leftJoin(people, eq(people.id, assignments.personId))
    .where(where)
    .orderBy(
      assignments.jobId,
      assignments.speakerLabel,
      sql`${assignments.turnIndex} asc nulls first`
    )
    .all();
  return rows.map(({ assignment: a, personName }) => ({
    inference: readInference(db, a.inference),
    jobId: a.jobId,
    personId: a.personId,
    personName,
    source: a.source,
    speakerLabel: a.speakerLabel,
    status: a.status,
    turnIndex: a.turnIndex,
  }));
}

// A person as the feed and the routes send them.
export const personRow = (p: typeof people.$inferSelect) => ({
  aliases: p.aliases,
  id: p.id,
  isOwner: p.isOwner,
  name: p.name,
});

// ---- Names ------------------------------------------------------------------

// A person by any name the owner uses for them: theirs or an alias, case aside.
export const isCalled = (
  person: { aliases: string[]; name: string },
  word: string
) => {
  const wanted = word.trim().toLowerCase();
  return (
    wanted !== "" &&
    [person.name, ...person.aliases].some((n) => n.toLowerCase() === wanted)
  );
};

// Aliases trimmed, each once (case aside), never the name itself.
export function aliasesOf(name: string, aliases: string[]) {
  const seen = new Set([name.trim().toLowerCase()]);
  return aliases.flatMap((a) => {
    const alias = a.trim();
    const key = alias.toLowerCase();
    if (!alias || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [alias];
  });
}

const UPKEEP_HOUR = 3;
const AFTER_CORRECTION_MS = 60_000;

// Voice upkeep, guarded so one run at a time: every night after 03:00 in the owner's zone the
// sweep, then expiry; a minute after the owner's last correction, the sweep alone, so a name given
// today reaches old conversations without waiting for the night.
// ponytail: in-process state and timer; assumes one server replica, like the other loops.
export function voiceUpkeep(db: Db) {
  let lastNight = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  const run = (work: () => Promise<Fields | null>) => {
    running = running.then(async () => {
      try {
        const fields = await work();
        if (fields) {
          record(db, "voices.upkeep", fields);
        }
      } catch (error: unknown) {
        reportError(db, "voice upkeep", error);
      }
    });
    return running;
  };
  return {
    nightly(at = clock()) {
      const { date, hour } = ownerClock(at);
      if (hour < UPKEEP_HOUR || date === lastNight) {
        return null;
      }
      lastNight = date;
      // Once a day across restarts too: a deploy after 03:00 finds the night's event.
      return run(async () =>
        recordedOn(db, "voices.upkeep", date)
          ? null
          : { ...(await sweep(db)), day: date, expired: expire(db) }
      );
    },
    soon() {
      clearTimeout(timer);
      timer = setTimeout(() => run(() => sweep(db)), AFTER_CORRECTION_MS);
    },
  };
}
export type VoiceUpkeep = ReturnType<typeof voiceUpkeep>;
