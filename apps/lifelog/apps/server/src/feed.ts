// The feed (docs/voice-source.md): what changed after a cursor, read from change_log by seq, for
// the phone and readers (GET /changes, routes/sync.ts).
// - A page is up to 500 log rows after the cursor; each (kind, ref) once, as its current row.
// - A row edited again is logged again, so it comes again under the same key with a newer seq.
// - What no longer exists (a turn a map moved off, a person merged away) is in `removed`.

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  changeLog,
  chapters,
  conversationJobs,
  conversations,
  isSettled,
  transcriptionJobs as jobs,
  macWatch,
  ownerEdits,
  people,
  quietRanges,
  speakerAssignments,
  turns,
} from "@lifelog/db/schema";
import {
  and,
  asc,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { type ChangeKind, latestSeq, turnRef } from "./change-log";
import { textOf } from "./elevenlabs";
import type { MacView } from "./mac-socket";
import { assignmentsByJob, personRow, speakerOf, voiceId } from "./people";
import { placeName } from "./places";
import { macView } from "./quiet-ranges";
import { latestValidRun, rendererFor, splitsOf } from "./summaries";
import {
  keptWords,
  personOf,
  timedWords,
  loadTurns as transcriptOf,
} from "./transcript";
import { vocabularyTerms } from "./vocabulary";

export const SEQ = /^\d+$/;
const PAGE = 500;

const iso = (d: Date | null) => d?.toISOString() ?? null;

// A long poll: true as soon as something is newer than `since`, false after `seconds`. Reads
// max(seq) about once a second. ponytail: polling; a wake-up from `logChange` if the second ever
// matters.
export async function waitForChange(
  db: Db,
  since: number,
  seconds: number,
  signal?: AbortSignal
) {
  const until = clock().getTime() + seconds * 1000;
  for (;;) {
    if (latestSeq(db) > since) {
      return true;
    }
    const left = until - clock().getTime();
    if (left <= 0 || signal?.aborted) {
      return false;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one read a second, by design
    await Bun.sleep(Math.min(1000, left));
  }
}

// The page after `since`. `live` is the Mac's view while its socket is open (else the stored one).
export function feed(
  db: Db,
  since: number,
  live: MacView | null = null,
  page = PAGE
) {
  const log = db
    .select({ kind: changeLog.kind, ref: changeLog.ref, seq: changeLog.seq })
    .from(changeLog)
    .where(gt(changeLog.seq, since))
    .orderBy(asc(changeLog.seq))
    .limit(page)
    .all();
  const refs = (kind: ChangeKind) => [
    ...new Set(log.filter((r) => r.kind === kind).map((r) => r.ref)),
  ];
  const owner = db
    .select({ id: people.id })
    .from(people)
    .where(sql`${people.isOwner}`)
    .get();
  const ownerPersonId = owner?.id ?? null;
  // A voice named or a person renamed changes what its speakers are called: the conversations they
  // speak in come again, with their chapters (rendered as they read now) and turns.
  const voiced = voicedIn(db, refs("assignment"), refs("person"));
  const conversationRefs = [...new Set([...refs("conversation"), ...voiced])];
  const conversationRows = loadConversations(db, conversationRefs);
  const turnRows = loadTurns(db, refs("turn"), voiced, ownerPersonId);
  const chapterRows = loadChapters(db, refs("chapter"), voiced);
  const jobRows = loadAll(db, jobs, refs("job"));
  const personRows = loadAll(db, people, refs("person"));
  const quiet = loadAll(db, quietRanges, refs("quietRange"));
  const edits = loadAll(db, ownerEdits, refs("edit"));
  const [stored] = live ? [] : db.select().from(macWatch).all();
  const gone = (kind: ChangeKind, found: { id: string }[]) =>
    refs(kind)
      .filter((ref) => !found.some((r) => r.id === ref))
      .map((ref) => ({ kind, ref }));
  // Withdrawn audio is a removed job with its first page: the phone sends those pages again.
  const withdrawn = refs("withdrawn").map((ref) => {
    const [id = "", first, ...source] = ref.split(":");
    const sourceId = source.join(":");
    return {
      firstPage: Number(first),
      kind: "job" as const,
      ref: id,
      sourceId,
    };
  });
  return {
    chapters: chapterRows,
    conversations: conversationRows,
    cursor: String(log.at(-1)?.seq ?? since),
    edits: edits.map((e) => ({
      at: iso(e.at),
      editedAt: e.editedAt.toISOString(),
      from: iso(e.from),
      id: e.id,
      kind: e.kind,
      source: e.source,
      target: e.target,
      to: iso(e.to),
      undoneAt: iso(e.undoneAt),
    })),
    jobs: jobRows.map((j) => ({
      durationSeconds: j.preparedDurationSeconds,
      endedOnSilence: j.endedOnSilence,
      id: j.id,
      pages: j.pages,
      sourceId: j.sourceId,
      state: j.state,
    })),
    more: log.length === page,
    people: personRows.map(personRow),
    quietRanges: quiet.map((q) => ({
      endedAt: q.endedAt.toISOString(),
      id: q.id,
      startedAt: q.startedAt.toISOString(),
    })),
    removed: [
      ...gone("chapter", chapterRows),
      ...gone("job", jobRows),
      ...withdrawn,
      ...gone("person", personRows),
      ...gone("edit", edits),
      ...turnRows.removed.map((ref) => ({ kind: "turn" as const, ref })),
    ],
    turns: turnRows.turns,
    vocabulary: vocabularyTerms(db),
    watch: live ?? (stored ? macView(stored) : null),
  };
}

// Rows of a table with a text `id`, by id.
function loadAll<T extends SQLiteTable & { id: SQLiteColumn }>(
  db: Db,
  table: T,
  ids: string[]
) {
  return (
    ids.length > 0
      ? db
          .select()
          .from(table as SQLiteTable)
          .where(inArray(table.id, ids))
          .all()
      : []
  ) as T["$inferSelect"][];
}

// The live conversations whose words these jobs' voices or these people speak.
function voicedIn(db: Db, jobIds: string[], personIds: string[]) {
  if (jobIds.length === 0 && personIds.length === 0) {
    return [];
  }
  const named = db
    .select({ jobId: speakerAssignments.jobId })
    .from(speakerAssignments)
    .where(inArray(speakerAssignments.personId, personIds));
  const rows = db
    .selectDistinct({ id: conversationJobs.conversationId })
    .from(conversationJobs)
    .where(
      or(
        inArray(conversationJobs.jobId, jobIds),
        inArray(conversationJobs.jobId, named)
      )
    )
    .all();
  return rows.map((r) => r.id);
}

// Chapters by id, and every chapter of these conversations, their summaries as they read now.
function loadChapters(db: Db, ids: string[], conversationIds: string[]) {
  if (ids.length === 0 && conversationIds.length === 0) {
    return [];
  }
  const rows = db
    .select()
    .from(chapters)
    .where(
      or(
        inArray(chapters.id, ids),
        inArray(chapters.conversationId, conversationIds)
      )
    )
    .all();
  const renderers = new Map(
    [...new Set(rows.map((c) => c.conversationId))].map(
      (id) => [id, rendererFor(db, id)] as const
    )
  );
  return rows.map((c) => ({
    conversationId: c.conversationId,
    endAt: c.endAt.toISOString(),
    id: c.id,
    startAt: c.startAt.toISOString(),
    summary:
      c.summary && (renderers.get(c.conversationId)?.(c.summary) ?? c.summary),
    title: c.title,
  }));
}

function loadConversations(db: Db, ids: string[]) {
  if (ids.length === 0) {
    return [];
  }
  const rows = db
    .select()
    .from(conversations)
    .where(inArray(conversations.id, ids))
    .all();
  const edits = db
    .select()
    .from(ownerEdits)
    .where(isNull(ownerEdits.undoneAt))
    .all();
  const neighbours = neighboursOf(db, ids);
  const dismissed = new Set(
    edits.filter((e) => e.kind === "dismissSplit").map((e) => e.at?.getTime())
  );
  // ponytail: a run and a place read per conversation; batch them if a page of 500 ever gets slow.
  return rows.map((c) => {
    const [start, end] = [
      c.captureStartedAt.getTime(),
      c.captureEndedAt.getTime(),
    ];
    const run = latestValidRun(db, c.id);
    const place = placeName(db, start, end);
    const edges = c.retiredAt
      ? NO_EDGES
      : edgesOf(edits, start, end, neighbours.get(c.id));
    return {
      closed: isSettled(c),
      endAt: c.captureEndedAt.toISOString(),
      endEdit: edges.end,
      id: c.id,
      kind: c.kind,
      ownerTitle: c.ownerTitle,
      ownerTitleAt: iso(c.ownerTitleAt),
      place,
      retired: c.retiredAt ? { successorId: c.successorId } : null,
      // The summary shown: what the owner's Generate names as seen (`after`).
      runId: run?.id ?? null,
      splitSuggestions: run ? splitSuggestions(run, start, end, dismissed) : [],
      startAt: c.captureStartedAt.toISOString(),
      startEdit: edges.start,
      state: c.state,
      title: run?.result.title.text ?? null,
      tldr: run?.result.tldr.text ?? null,
      waiting: c.waitingReason
        ? { reason: c.waitingReason, since: iso(c.waitingSince) }
        : null,
    };
  });
}

// Where the live conversations before and after each one end and start (same source), epoch ms.
function neighboursOf(db: Db, ids: string[]) {
  const rows = db.all<{
    after: number | null;
    before: number | null;
    id: string;
  }>(sql`
    select c.id,
      (select max(p.capture_ended_at) from conversations p where p.retired_at is null
        and p.source_id is c.source_id and p.id <> c.id
        and p.capture_ended_at <= c.capture_started_at) as before,
      (select min(n.capture_started_at) from conversations n where n.retired_at is null
        and n.source_id is c.source_id and n.id <> c.id
        and n.capture_started_at >= c.capture_ended_at) as after
    from conversations c where c.id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `
    )})`);
  return new Map(rows.map(({ id, ...around }) => [id, around]));
}

const NO_EDGES = { end: null, start: null };

// The live edits that made a conversation's edges, so Undo names the right one: `start`, the
// split its start comes from (one in the gap before it, or at its start), else the latest merge
// that joined it; `end`, the split its end comes from. Grouping cuts at a split's instant and
// starts the next conversation at its first speech, so a split may lie a little before the start.
function edgesOf(
  edits: (typeof ownerEdits.$inferSelect)[],
  start: number,
  end: number,
  around: { after: number | null; before: number | null } | undefined
) {
  const splitIn = (from: number, to: number) =>
    edits.findLast((e) => {
      const at = e.kind === "split" ? e.at?.getTime() : undefined;
      return at !== undefined && from <= at && at <= to;
    })?.id ?? null;
  const merge = edits.findLast(
    (e) =>
      e.kind === "merge" &&
      e.from !== null &&
      e.to !== null &&
      e.from.getTime() < end &&
      e.to.getTime() > start
  )?.id;
  return {
    end: splitIn(end, around?.after ?? end),
    start: splitIn(around?.before ?? start, start) ?? merge ?? null,
  };
}

// The run's medium-confidence splits inside the conversation, minus the dismissed ones (a high one
// is already an AI split, intelligence.ts `splitAtBoundaries`).
function splitSuggestions(
  run: NonNullable<Awaited<ReturnType<typeof latestValidRun>>>,
  start: number,
  end: number,
  dismissed: Set<number | undefined>
) {
  return splitsOf(run.result, run.turns, "medium")
    .filter(({ at }) => at > start && at < end && !dismissed.has(at))
    .map(({ at }) => ({
      at: new Date(at).toISOString(),
      confidence: "medium" as const,
    }));
}

// The live conversation each instant falls in ([start, end)), from one read of those around them.
function holdersOf(db: Db, instants: number[]) {
  if (instants.length === 0) {
    return () => null;
  }
  const rows = db
    .select({
      end: conversations.captureEndedAt,
      id: conversations.id,
      start: conversations.captureStartedAt,
    })
    .from(conversations)
    .where(
      and(
        isNull(conversations.retiredAt),
        lte(conversations.captureStartedAt, new Date(Math.max(...instants))),
        gt(conversations.captureEndedAt, new Date(Math.min(...instants)))
      )
    )
    .orderBy(asc(conversations.captureStartedAt))
    .all();
  return (at: number) =>
    rows.find((r) => r.start.getTime() <= at && at < r.end.getTime())?.id ??
    null;
}

// The turns asked for, and every turn of the conversations whose speakers changed names. Text as
// every reader shows it (transcript.ts `keptWords`): empty when a quiet range or a media speaker
// hides it all. Each carries the live conversation it starts in (the server places words, the one
// rule) and its speaker's name as that conversation's transcript gives it. A turn is final when
// it lands (blocks are complete jobs); a changed one comes again under its key.
function loadTurns(
  db: Db,
  refs: string[],
  conversationIds: string[],
  ownerPersonId: string | null
) {
  const asked = refs.flatMap((r) => {
    const [jobId = "", index = ""] = r.split(":");
    return [sql`(${jobId}, ${Number(index)})`];
  });
  const ranges =
    conversationIds.length > 0
      ? db
          .select({
            end: conversations.captureEndedAt,
            start: conversations.captureStartedAt,
          })
          .from(conversations)
          .where(inArray(conversations.id, conversationIds))
          .all()
      : [];
  const rows =
    asked.length > 0 || ranges.length > 0
      ? db
          .select()
          .from(turns)
          .where(
            or(
              asked.length > 0
                ? sql`(${turns.jobId}, ${turns.turnIndex}) in (values ${sql.join(asked, sql`, `)})`
                : undefined,
              ...ranges.map((r) =>
                and(gte(turns.startAt, r.start), lt(turns.startAt, r.end))
              )
            )
          )
          .all()
      : [];
  const found = new Set(rows.map((t) => turnRef(t.jobId, t.turnIndex)));
  const removed = refs.filter((r) => !found.has(r));
  if (rows.length === 0) {
    return { removed, turns: [] };
  }
  const starts = rows.map((t) => t.startAt.getTime());
  const from = new Date(Math.min(...starts));
  const to = new Date(Math.max(...rows.map((t) => t.endAt.getTime())));
  const byJob = assignmentsByJob(
    db,
    rows.map((t) => t.jobId)
  );
  const quiet = db
    .select()
    .from(quietRanges)
    .where(and(lt(quietRanges.startedAt, to), gt(quietRanges.endedAt, from)))
    .all();
  const holder = holdersOf(db, starts);
  const names = namesIn(
    db,
    rows.map((t) => holder(t.startAt.getTime()))
  );
  const spans = quiet.map(
    (q) => [q.startedAt.getTime(), q.endedAt.getTime()] as const
  );
  return {
    removed,
    turns: rows.map((t) => {
      const speaker = speakerOf(
        byJob.get(t.jobId),
        t.speakerLabel,
        t.turnIndex
      );
      const person = personOf(speaker);
      const conversationId = holder(t.startAt.getTime());
      const voices = names.get(conversationId ?? "");
      return {
        conversationId,
        endAt: t.endAt.toISOString(),
        jobId: t.jobId,
        language: t.language,
        speaker: {
          displayName: displayName(person, voices, t),
          isOwner: person?.id === ownerPersonId,
          label: t.speakerLabel,
          personId: person?.id ?? null,
          personName: person?.name ?? null,
        },
        startAt: t.startAt.toISOString(),
        turnIndex: t.turnIndex,
        ...shown(t, speaker?.status === "media", spans),
      };
    }),
  };
}

// The turn's speaker as its conversation's transcript names it: the person, else its voice there.
const displayName = (
  person: { name: string } | null,
  voices: Map<string, string> | undefined,
  t: { jobId: string; speakerLabel: string | null }
) => person?.name ?? voices?.get(voiceId(t.jobId, t.speakerLabel)) ?? "Speaker";

// What each conversation's transcript calls each voice (transcript.ts `speakerNames`).
// ponytail: one transcript read per conversation on the page; a voice-order query if it gets slow.
function namesIn(db: Db, ids: (string | null)[]) {
  const unique = [...new Set(ids.flatMap((id) => (id ? [id] : [])))];
  return new Map(
    unique.map((id) => {
      const voices = new Map<string, string>();
      const loaded = transcriptOf(db, id);
      for (const t of loaded?.turns ?? []) {
        if (!t.person) {
          voices.set(voiceId(t.ref.jobId, t.speakerLabel), t.speaker);
        }
      }
      return [id, voices] as const;
    })
  );
}

// The turn as every reader shows it (transcript.ts `keptWords`): its text and timed words.
function shown(
  t: typeof turns.$inferSelect,
  media: boolean,
  quiet: (readonly [number, number])[]
) {
  const kept = (!media && keptWords(t.words, t.startAt.getTime(), quiet)) || [];
  return {
    text: kept === t.words ? t.text : textOf(kept),
    words: timedWords(kept, t.startAt.getTime()),
  };
}
