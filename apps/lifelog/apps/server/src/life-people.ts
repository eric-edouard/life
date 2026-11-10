// The authenticated, replaceable Life identity snapshot; no Life files or memory code are read here.
import type { Db } from "@lifelog/db";
import {
  lifePeopleSnapshot,
  namingAttempts,
  people,
  speakerAssignments,
} from "@lifelog/db/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { logChange } from "./change-log";
import { sha256Hex } from "./config";
import { cleanupInferredPeople, merge } from "./people";

const LifePerson = z.strictObject({
  aliases: z.array(z.string().trim().min(1)),
  name: z.string().trim().min(1),
  personId: z.uuid().nullable(),
  ref: z.string().trim().min(1),
});
export const LifePeopleInput = z.strictObject({
  complete: z.literal(true),
  folds: z.record(z.string().min(1), z.string().min(1)),
  people: z.array(LifePerson),
  revision: z.int().nonnegative(),
  version: z.literal(1),
});
type Snapshot = z.infer<typeof LifePeopleInput>;

export class SnapshotConflict extends Error {}

// A fold is an identity retargeting, not a second eligible person.
export function canonicalOf(folds: Record<string, string>, ref: string) {
  const seen = new Set<string>();
  let current = ref;
  while (Object.hasOwn(folds, current)) {
    if (seen.has(current)) {
      throw new SnapshotConflict("cyclic Life folds");
    }
    seen.add(current);
    current = folds[current] as string;
  }
  return current;
}

function parsedSnapshot(input: unknown) {
  const parsed = LifePeopleInput.parse(input);
  const refs = new Set(parsed.people.map((p) => p.ref));
  if (refs.size !== parsed.people.length) {
    throw new SnapshotConflict("duplicate Life reference");
  }
  const folds = Object.fromEntries(
    Object.keys(parsed.folds)
      .sort()
      .map((ref) => {
        const canonical = canonicalOf(parsed.folds, ref);
        if (!refs.has(canonical)) {
          throw new SnapshotConflict("fold has no confident canonical person");
        }
        return [ref, canonical];
      })
  );
  const linked = new Map<string, string>();
  for (const person of parsed.people) {
    if (person.personId) {
      const canonical = canonicalOf(folds, person.ref);
      const before = linked.get(person.personId);
      if (before && before !== canonical) {
        throw new SnapshotConflict(
          "one lifelog person has conflicting Life links"
        );
      }
      linked.set(person.personId, canonical);
    }
  }
  return {
    ...parsed,
    folds,
    people: parsed.people
      .map((p) => ({
        ...p,
        aliases: [...new Set(p.aliases)].sort(),
      }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
  };
}

export const readLifePeople = (db: Db) =>
  db
    .select()
    .from(lifePeopleSnapshot)
    .where(eq(lifePeopleSnapshot.id, 1))
    .get();

// A complete replacement either reconciles all explicit links/folds or changes nothing.
export function replaceLifePeople(db: Db, input: unknown) {
  const snapshot = parsedSnapshot(input);
  const hash = sha256Hex(
    JSON.stringify({
      complete: snapshot.complete,
      folds: snapshot.folds,
      people: snapshot.people,
      version: snapshot.version,
    })
  );
  return db.transaction((tx) => {
    const previous = readLifePeople(tx);
    if (
      previous &&
      (snapshot.revision < previous.revision ||
        (snapshot.revision === previous.revision && hash !== previous.hash))
    ) {
      throw new SnapshotConflict("older or conflicting Life snapshot revision");
    }
    if (previous?.hash === hash) {
      if (snapshot.revision > previous.revision) {
        tx.update(lifePeopleSnapshot)
          .set({ revision: snapshot.revision })
          .where(eq(lifePeopleSnapshot.id, 1))
          .run();
      }
      return { changed: false, revision: snapshot.revision };
    }
    reconcileLinks(tx, snapshot, previous);
    const canonical = snapshot.people.filter(
      (p) => !Object.hasOwn(snapshot.folds, p.ref)
    );
    const refs = new Set(canonical.map((p) => p.ref));
    const removed = tx
      .select()
      .from(people)
      .all()
      .filter((p) => p.lifeRef && !refs.has(p.lifeRef));
    if (removed.length > 0) {
      const ids = removed.map((p) => p.id);
      const deleted = tx
        .delete(speakerAssignments)
        .where(
          and(
            inArray(speakerAssignments.personId, ids),
            eq(speakerAssignments.source, "inferred")
          )
        )
        .returning({ jobId: speakerAssignments.jobId })
        .all();
      tx.update(people)
        .set({ lifeRef: null })
        .where(inArray(people.id, ids))
        .run();
      logChange(
        tx,
        "assignment",
        deleted.map((r) => r.jobId)
      );
      logChange(tx, "person", ids);
    }
    // Attempt results are input-bound; call accounting stays durable after invalidation.
    tx.update(namingAttempts)
      .set({
        error: "Life snapshot changed",
        nextEligibleAt: null,
        result: null,
        state: "failed",
      })
      .run();
    tx.insert(lifePeopleSnapshot)
      .values({
        folds: snapshot.folds,
        hash,
        id: 1,
        people: canonical,
        revision: snapshot.revision,
      })
      .onConflictDoUpdate({
        set: {
          folds: snapshot.folds,
          hash,
          people: canonical,
          revision: snapshot.revision,
        },
        target: lifePeopleSnapshot.id,
      })
      .run();
    cleanupInferredPeople(tx);
    return { changed: true, revision: snapshot.revision };
  });
}

function reconcileLinks(
  tx: Db,
  snapshot: Snapshot,
  previous: ReturnType<typeof readLifePeople>
) {
  for (const person of snapshot.people.filter(
    (p) => !Object.hasOwn(snapshot.folds, p.ref)
  )) {
    reconcilePerson(tx, snapshot, person, previous);
  }
}

function reconcilePerson(
  tx: Db,
  snapshot: Snapshot,
  person: Snapshot["people"][number],
  previous: ReturnType<typeof readLifePeople>
) {
  const oldRefs = Object.entries(snapshot.folds)
    .filter(([, target]) => target === person.ref)
    .map(([ref]) => ref);
  const hints = snapshot.people.filter((p) => oldRefs.includes(p.ref));
  const explicit = [person, ...hints].flatMap((p) => p.personId ?? []);
  const found = tx
    .select()
    .from(people)
    .where(
      or(
        eq(people.lifeRef, person.ref),
        inArray(people.lifeRef, oldRefs),
        inArray(people.id, explicit)
      )
    )
    .all();
  const canonical = found.find((p) => p.lifeRef === person.ref);
  for (const p of [person, ...hints]) {
    // Life's owner-authored old link survives the merge that deleted its lifelog duplicate.
    const replayedFold = isReplayedFold(
      previous,
      snapshot,
      p.ref,
      person.ref,
      found
    );
    if (
      p.personId &&
      !found.some((f) => f.id === p.personId) &&
      !replayedFold &&
      !isRetargetedLink(previous, p.ref, p.personId, canonical)
    ) {
      throw new SnapshotConflict("explicit lifelog person does not exist");
    }
  }
  if (
    found.some(
      (p) =>
        p.lifeRef && p.lifeRef !== person.ref && !oldRefs.includes(p.lifeRef)
    )
  ) {
    throw new SnapshotConflict("conflicting explicit Life link");
  }
  if (
    canonical &&
    person.personId &&
    canonical.id !== person.personId &&
    !isRetargetedLink(previous, person.ref, person.personId, canonical)
  ) {
    throw new SnapshotConflict(
      "canonical Life link conflicts with explicit link"
    );
  }
  const into =
    canonical ?? found.find((p) => p.id === person.personId) ?? found[0];
  if (!into) {
    return;
  }
  for (const from of found.filter((p) => p.id !== into.id)) {
    if (
      !(
        oldRefs.includes(from.lifeRef ?? "") ||
        hints.some((p) => p.personId === from.id)
      )
    ) {
      throw new SnapshotConflict("merge is not authorized by a Life fold");
    }
    merge(tx, into.id, from.id);
  }
  tx.update(people)
    .set({
      lifeRef: person.ref,
      name: sql`case when ${people.nameSource} = 'inferred' then ${person.name} else ${people.name} end`,
    })
    .where(eq(people.id, into.id))
    .run();
  logChange(tx, "person", into.id);
}

// An owner merge retargets the link; Life's unchanged explicit id remains its provenance.
function isRetargetedLink(
  previous: ReturnType<typeof readLifePeople>,
  ref: string,
  oldId: string,
  canonical: { lifeRef: string | null } | undefined
) {
  return (
    canonical?.lifeRef === ref &&
    !!previous?.people.some((p) => p.ref === ref && p.personId === oldId)
  );
}

function isReplayedFold(
  previous: ReturnType<typeof readLifePeople>,
  snapshot: Snapshot,
  ref: string,
  canonical: string,
  found: { lifeRef: string | null }[]
) {
  const target =
    previous && Object.hasOwn(previous.folds, ref) ? previous.folds[ref] : null;
  return (
    ref !== canonical &&
    !!target &&
    canonicalOf(snapshot.folds, target) === canonical &&
    found.some((p) => p.lifeRef === target || p.lifeRef === canonical)
  );
}

// Called only inside the recognition transaction after its input/owner checks pass.
export function resolveLifePerson(tx: Db, id: string) {
  const snapshot = readLifePeople(tx);
  const existing = tx.select().from(people).where(eq(people.id, id)).get();
  if (existing) {
    return existing.id;
  }
  const ref = id.startsWith("life:") ? id.slice("life:".length) : id;
  const canonical = snapshot ? canonicalOf(snapshot.folds, ref) : ref;
  const candidate = snapshot?.people.find((p) => p.ref === canonical);
  if (!candidate) {
    return null;
  }
  const linked = tx
    .select()
    .from(people)
    .where(eq(people.lifeRef, canonical))
    .get();
  if (linked) {
    return linked.id;
  }
  if (candidate.personId) {
    // Removed explicit targets cannot silently become a newly created person.
    return null;
  }
  const person = tx
    .insert(people)
    .values({
      creationSource: "inferred",
      lifeRef: canonical,
      name: candidate.name,
      nameSource: "inferred",
    })
    .returning()
    .get();
  if (person) {
    logChange(tx, "person", person.id);
  }
  return person?.id ?? null;
}
