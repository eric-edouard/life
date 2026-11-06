// The server cuts the blocks (docs/timeline.md, "Fragments and blocks"). The phone sends its kept
// speech as fragments of whole Pendant pages (`storeFragment`); a source's open fragments, in
// capture order, close into blocks on the server's own clock (`blockFrom`); a closed block passes
// the Mac's gate, the quiet ranges and what is bought already, is joined into one Ogg (audio.ts
// `joinOggOpus`) and admitted as one job (`admit`), the only way a job is made. The job
// worker's `claim` stays the one way to ElevenLabs and checks the Mac and the quiet ranges again: a
// range that comes late withdraws one fragment here, the whole job there. A page is in one
// fragment, and in one job that isn't failed. A fragment is open while it has audio, in a job
// once it has a job, and covered (its pages held, nothing sent) with neither. The rules the worker
// shares (`touchesQuiet`, `withdrawRows`) are here too, so jobs.ts calls the cutter and not back.

import type { Db } from "@lifelog/db";
import {
  hasRawPages,
  holdsPages,
  type JobMap,
  transcriptionJobs as jobs,
  joinTouching,
  type PageRanges,
  quietRanges,
  sources,
  speechFragments,
  type TranscriptionSettings,
} from "@lifelog/db/schema";
import { and, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { joinOggOpus, oggOpusSeconds } from "./audio";
import {
  type AudioStore,
  blockKey,
  fragmentKey,
  storeAudio,
} from "./audio-store";
import { logChange } from "./change-log";
import { billableSeconds, sha256Hex } from "./config";
import { reportError } from "./diagnostics";
import { record } from "./events";
import { captureRange } from "./turns";
import { blockKeyterms } from "./vocabulary";

type Fragment = typeof speechFragments.$inferSelect;

// A block closes at 2 minutes of kept speech, at its widest gap between fragments after 1.5.
const CAP_MS = 120_000;
const CUT_FROM_MS = 90_000;
// A pause the phone saw closes a block of a minute or more at 5 s.
const PAUSE_MS = 5000;
const LONG_MS = 60_000;
// Otherwise a block closes 30 s after its last speech: nothing came by the server's clock.
const CLOCK_MS = 30_000;

// A fragment as the close rules read it, in epoch ms: its first and last kept instants, and its
// kept length.
export interface Span {
  end: number;
  kept: number;
  start: number;
}

const spanOf = (map: JobMap): Span => ({
  ...(captureRange(map) ?? { end: 0, start: 0 }),
  kept: map.segments.reduce((sum, [from, to]) => sum + to - from, 0),
});

// At the cap: the fragment after which the gap is widest, once the block holds 1.5 minutes. A seam
// inside a long stretch is a gap of 0, so it is taken only when there is no pause; after the last
// fragment, the gap is what the phone saw.
function widestGap(open: Span[], from: number, to: number, said: number) {
  let best = to;
  let widest = Number.NEGATIVE_INFINITY;
  let kept = 0;
  for (let j = from; j <= to; j += 1) {
    const span = open[j] ?? { end: 0, kept: 0, start: 0 };
    kept += span.kept;
    const gap = (open[j + 1]?.start ?? said) - span.end;
    if (kept >= CUT_FROM_MS && gap > widest) {
      best = j;
      widest = gap;
    }
  }
  return best;
}

// The block that starts at fragment `from` of a source's open ones (in capture order): its last
// fragment once it closes, else when the server's clock may close it (null: only a fragment or the
// phone's word can), and whether it closed on rule 3 (`onSilence`, the job's `endedOnSilence`).
// `sent` is the phone's sentThrough, `heard` heard-through, `now` the wall clock.
// A block closes:
// 1. at the cap, 2 minutes of kept speech;
// 2. on a pause the phone saw (nothing kept between its end and the next fragment or `sent`) of 5 s,
//    once it holds a minute;
// 3. 30 s after its end by the server's clock, when nothing kept came in those 30 s: the next
//    fragment starts later, and the phone sent through them or had nothing left (`sent` reached
//    `heard`).
export function blockFrom(
  open: Span[],
  from: number,
  sent: number | null,
  heard: number | null,
  now: number
) {
  const said = sent ?? Number.NEGATIVE_INFINITY;
  const idle = sent !== null && heard !== null && sent >= heard;
  let kept = 0;
  let wakeAt: number | null = null;
  for (let k = from; k < open.length; k += 1) {
    const { end, kept: length } = open[k] ?? { end: 0, kept: 0 };
    kept += length;
    if (kept >= CAP_MS) {
      return {
        last: widestGap(open, from, k, said),
        onSilence: false,
        wakeAt: null,
      };
    }
    const next = open[k + 1]?.start ?? Number.POSITIVE_INFINITY;
    const seen = Math.min(next, said) - end;
    const silent = idle ? next - end : seen;
    const rule = closesNow(seen, silent, kept, now - end);
    if (rule) {
      return { last: k, onSilence: rule === "silence", wakeAt: null };
    }
    wakeAt ??= silent >= CLOCK_MS ? end + CLOCK_MS : null;
  }
  return { last: null, onSilence: false, wakeAt };
}

// Rule 3, nothing kept (`silent`) for 30 s by the server's clock (`waited`); rule 2, a pause the
// phone saw (`seen`) once the block holds a minute. Null: it stays open.
function closesNow(seen: number, silent: number, kept: number, waited: number) {
  if (silent >= CLOCK_MS && waited >= CLOCK_MS) {
    return "silence";
  }
  return seen >= PAUSE_MS && kept >= LONG_MS ? "pause" : null;
}

// Closes every block that is due into a job, oldest first, and says when the server's clock may
// close the next. A block ending past what the Mac vouches for waits, with those after it: every
// state the Mac sends runs the worker again. A block that fails is recorded and the next goes on;
// its third failure withdraws its fragments, so the phone sends their pages again.
export async function cut(
  db: Db,
  audio: AudioStore,
  vouched: Date,
  now: number
) {
  const rows = db
    .select({
      fragment: speechFragments,
      heard: sources.heardThrough,
      sent: sources.sentThrough,
    })
    .from(speechFragments)
    .leftJoin(sources, eq(sources.id, speechFragments.sourceId))
    .where(isNotNull(speechFragments.objectKey))
    .orderBy(speechFragments.sourceId, speechFragments.captureStart)
    .all();
  const wakes: number[] = [];
  for (const group of Map.groupBy(rows, (r) => r.fragment.sourceId).values()) {
    // biome-ignore lint/performance/noAwaitInLoops: one source after the other
    const wakeAt = await cutSource(db, audio, group, vouched.getTime(), now);
    wakes.push(...(wakeAt === null ? [] : [wakeAt]));
  }
  return wakes.length > 0 ? Math.min(...wakes) : null;
}

// One source's open fragments, in capture order, with what the phone last said.
async function cutSource(
  db: Db,
  audio: AudioStore,
  group: { fragment: Fragment; heard: Date | null; sent: Date | null }[],
  vouched: number,
  now: number
) {
  const fragments = group.map((r) => r.fragment);
  const spans = fragments.map((f) => spanOf(f.map));
  const sent = group[0]?.sent?.getTime() ?? null;
  const heard = group[0]?.heard?.getTime() ?? null;
  for (let from = 0; from < spans.length; ) {
    const { last, onSilence, wakeAt } = blockFrom(
      spans,
      from,
      sent,
      heard,
      now
    );
    if (last === null) {
      return wakeAt;
    }
    const block = fragments.slice(from, last + 1);
    if (Math.max(...spans.slice(from, last + 1).map((s) => s.end)) > vouched) {
      return null;
    }
    // biome-ignore lint/performance/noAwaitInLoops: blocks in order
    await close(db, audio, block, onSilence).catch((error: unknown) =>
      failed(db, audio, block, error)
    );
    from = last + 1;
  }
  return null;
}

const MAX_FAILURES = 3;
async function failed(
  db: Db,
  audio: AudioStore,
  block: Fragment[],
  error: unknown
) {
  const fragment = block[0]?.id ?? "";
  record(db, "block.failed", {
    error: String(error).slice(0, 120),
    fragment,
  });
  const [tries] = db.all<{ n: number }>(sql`
    select count(*) as n from events
    where name = 'block.failed' and fields ->> '$.fragment' = ${fragment}`);
  for (const f of (tries?.n ?? 0) >= MAX_FAILURES ? block : []) {
    // biome-ignore lint/performance/noAwaitInLoops: one after the other
    await withdraw(db, audio, f, "failed");
  }
}

// A closed block: the fragments bought already are covered and those a quiet range touches
// withdrawn; the rest are joined and admitted as one job that takes them, in one transaction.
async function close(
  db: Db,
  audio: AudioStore,
  block: Fragment[],
  endedOnSilence: boolean
) {
  const parts = await readable(db, audio, block);
  const own = parts.map((p) => p.fragment);
  const [first] = own;
  if (!first) {
    return;
  }
  // Each fragment was checked to join at upload.
  const joined = joinOggOpus(parts);
  if (!joined) {
    throw new Error(`fragments from ${first.id} don't join`);
  }
  const pages = joinTouching(
    own.flatMap((f) => f.pages).sort(([a], [b]) => a - b)
  );
  const sha = sha256Hex(joined.audio);
  const key = blockKey(first.sourceId, pages[0]?.[0] ?? 0, sha);
  await audio.put(key, joined.audio);
  // Its pages are its fragments' alone, and each was judged bought on its own.
  const job = admit(
    db,
    {
      audioSha256: sha,
      endedOnSilence,
      map: joined.map,
      objectKey: key,
      pages,
      preparedDurationSeconds: oggOpusSeconds(joined.audio) ?? 0,
      settings: {
        keyterms: blockKeyterms(db),
        languageCode: null,
        numSpeakers: null,
      },
      sourceId: first.sourceId,
    },
    own.map((f) => f.id)
  );
  await Promise.all(own.map((f) => dropAudio(db, audio, f)));
  record(db, "block.closed", { fragments: own.length, job: job.id });
}

// The block's fragments with their audio. Those bought already are covered and those a quiet range
// touches, or whose audio the bucket lost, withdrawn: none is read.
async function readable(db: Db, audio: AudioStore, block: Fragment[]) {
  const parts: { audio: Uint8Array; fragment: Fragment; map: JobMap }[] = [];
  for (const fragment of block) {
    if (bought(db, fragment.map, fragment.sourceId)) {
      // biome-ignore lint/performance/noAwaitInLoops: a few fragments, in order
      await cover(db, audio, fragment);
      continue;
    }
    const bytes =
      !touchesQuiet(db, fragment.map) &&
      (await audio.get(fragment.objectKey ?? ""));
    if (bytes) {
      parts.push({ audio: bytes, fragment, map: fragment.map });
    } else {
      await withdraw(
        db,
        audio,
        fragment,
        bytes === false ? "quiet" : "no_audio"
      );
    }
  }
  return parts;
}

const dropAudio = (db: Db, audio: AudioStore, fragment: Fragment) =>
  audio
    .delete(fragment.objectKey ?? "")
    .catch((error: unknown) => reportError(db, "fragment delete", error));

// Audio bought already, or from before the quiet ranges: it leaves the bucket unread, and its pages
// stay held.
async function cover(db: Db, audio: AudioStore, fragment: Fragment) {
  const row = db
    .update(speechFragments)
    .set({ objectKey: null })
    .where(
      and(
        eq(speechFragments.id, fragment.id),
        isNotNull(speechFragments.objectKey)
      )
    )
    .returning({ id: speechFragments.id })
    .get();
  if (row) {
    await dropAudio(db, audio, fragment);
    record(db, "fragment.covered", { fragment: fragment.id });
  }
}

// A fragment a quiet range touches, or whose audio the bucket lost, goes: its row and its audio.
// The feed lists its id as a removed job with its first page, so the phone sends its pages again
// (without the range).
async function withdraw(
  db: Db,
  audio: AudioStore,
  fragment: Fragment,
  why: string
) {
  const gone = await withdrawRows(db, audio, (tx) => {
    const row = tx
      .delete(speechFragments)
      .where(
        // Still open: neither in a job nor covered by a cut racing this one.
        and(
          eq(speechFragments.id, fragment.id),
          isNull(speechFragments.jobId),
          isNotNull(speechFragments.objectKey)
        )
      )
      .returning({
        key: speechFragments.objectKey,
        pages: speechFragments.pages,
        sourceId: speechFragments.sourceId,
      })
      .get();
    return row && { ...row, ids: [fragment.id] };
  });
  if (gone) {
    record(db, "fragment.withdrawn", { fragment: fragment.id, why });
  }
}

// The same fragment (an upload sent again), "held" when a job or another fragment holds any of
// these pages, else null.
function holding(db: Db, upload: BlockIdentity) {
  const holder = holderOf(db, upload);
  if (holder?.kind === "fragment" && holder.same) {
    const row = db
      .select()
      .from(speechFragments)
      .where(eq(speechFragments.id, holder.id))
      .get();
    return row ?? ("held" as const);
  }
  return holder && ("held" as const);
}

// Stores a fragment, or says what holds its pages; idempotent. "unavailable": the bucket failed
// and nothing was kept.
export async function storeFragment(
  db: Db,
  audio: AudioStore,
  upload: BlockIdentity,
  bytes: Uint8Array
): Promise<Fragment | "held" | "unavailable"> {
  const known = holding(db, upload);
  if (known) {
    return known;
  }
  const key = fragmentKey(
    upload.sourceId,
    upload.pages[0]?.[0] ?? 0,
    upload.audioSha256
  );
  if (!(await storeAudio(audio, key, bytes))) {
    return "unavailable";
  }
  const range = captureRange(upload.map) ?? { end: 0, start: 0 };
  // The look and the insert in one synchronous transaction: nothing takes these pages between
  // them. ponytail: pages taken while the audio was stored leave this audio in the bucket, unread
  // and unnamed by any row; sweep `fragments/` keys no row names if that ever happens.
  return db.transaction((tx) => {
    const holder = holding(tx, upload);
    if (holder) {
      return holder;
    }
    const row = tx
      .insert(speechFragments)
      .values({
        ...upload,
        captureEnd: new Date(range.end),
        captureStart: new Date(range.start),
        objectKey: key,
      })
      .returning()
      .get();
    if (!row) {
      throw new Error("fragment write lost");
    }
    return row;
  });
}

// What makes a fragment the same fragment, and what it may not take (`holderOf`).
export interface BlockIdentity {
  audioSha256: string;
  map: JobMap;
  pages: PageRanges;
  sourceId: string;
}

export interface AdmissionRequest extends BlockIdentity {
  endedOnSilence: boolean;
  // Where the audio is in the bucket, stored before admission.
  objectKey: string;
  // Measured by the server from the audio.
  preparedDurationSeconds: number;
  settings: TranscriptionSettings;
}

const settingsHash = (s: TranscriptionSettings) =>
  new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        "scribe_v2",
        s.languageCode,
        s.numSpeakers,
        [...s.keyterms].sort(),
      ])
    )
    .digest("hex");

// The first quiet range the Mac recorded (production, read on Oct 15). Audio that starts before it
// may hold dictation no range hides, so it is never sent: `covered`.
export const QUIET_RANGES_FROM = Date.parse("2026-10-10T07:14:59.703Z");

// Audio a block shares with a bought job by more than this is bought again. ponytail: two clock
// models may place the same edge a second apart; a real overlap is a whole stretch of speech.
const BOUGHT_OVERLAP_MS = 2000;

// Whether a fragment's kept audio lies on audio a completed or submitted job bought (its map's
// segments), whatever pages either holds: a job the handover left without pages, or an old part
// whose pages went to another job, can't be bought again. Imported recordings are other streams.
// The source's own jobs since its handover are judged by pages alone (`holderOf`): whole pages
// share no audio, and a map an older clock model placed must not cover new audio.
function alreadyBought(db: Pick<Db, "all">, map: JobMap, sourceId: string) {
  const range = captureRange(map);
  if (!range) {
    return false;
  }
  const [hit] = db.all(sql`
    select 1 from transcription_jobs j, json_each(j.map, '$.segments') s,
      json_each(${JSON.stringify(map.segments)}) b
    where j.state in ('completed', 'submitted')
      and coalesce(j.source_id, '') not like 'import:%'
      and (j.pages is null or j.source_id is not ${sourceId}
        or j.created_at < (select handed_over_at from sources where id = ${sourceId}))
      and j.capture_start < ${range.end} and j.capture_end > ${range.start}
      and min(b.value ->> 1, s.value ->> 1)
        - max(b.value ->> 0, s.value ->> 0) > ${BOUGHT_OVERLAP_MS}
    limit 1`);
  return hit !== undefined;
}

// Audio a completed or submitted job already bought, or from before the quiet ranges: never sent.
export function bought(db: Db, map: JobMap, sourceId: string) {
  const start = captureRange(map)?.start ?? Number.POSITIVE_INFINITY;
  return start < QUIET_RANGES_FROM || alreadyBought(db, map, sourceId);
}

// What holds any of these pages: a job (any state) or a speech fragment (but `own`), the same
// fragment (pages and audio) first. Null when nothing does. Paid work happens once: this is the
// only guard (no constraint holds it), so every caller asks it inside the synchronous transaction
// that writes, where nothing else runs between the look and the write.
function holderOf(
  db: Pick<Db, "all">,
  { audioSha256, pages, sourceId }: Omit<BlockIdentity, "map">,
  own: string[] = []
) {
  const wanted = JSON.stringify(pages);
  const holds = (table: string) =>
    sql`source_id = ${sourceId} and ${holdsPages(table, pages)}`;
  const [holder] = db.all<{
    id: string;
    kind: "fragment" | "job";
    same: number;
  }>(sql`
    select 'job' as kind, id, 0 as same from transcription_jobs where ${holds("transcription_jobs")}
    union all
    select 'fragment', id, audio_sha256 = ${audioSha256} and pages = ${wanted}
    from speech_fragments
    where ${holds("speech_fragments")}
      and id not in (select value from json_each(${JSON.stringify(own)}))
    order by same desc limit 1`);
  return holder ? { ...holder, same: Boolean(holder.same) } : null;
}

// Whether a map keeps audio inside a quiet range (the owner dictating to the Mac, or the phone
// playing a recording back): that audio is never sent anywhere.
export function touchesQuiet(db: Db, map: JobMap) {
  const range = captureRange(map);
  if (!range) {
    return false;
  }
  const quiet = db
    .select()
    .from(quietRanges)
    .where(
      and(
        lt(quietRanges.startedAt, new Date(range.end)),
        gt(quietRanges.endedAt, new Date(range.start))
      )
    )
    .all();
  return quiet.some((q) =>
    map.segments.some(
      ([from, to]) => q.startedAt.getTime() < to && from < q.endedAt.getTime()
    )
  );
}

// Admits the cutter's job. It takes its fragments (`own`) in the same transaction, their pages its
// pages, and rolls back if one was taken or withdrawn meanwhile, or a job holds any of its pages
// (a failed one too: paid work happens once). Synchronous: the check and the writes are one
// transaction nothing interleaves with.
export function admit(db: Db, req: AdmissionRequest, own: string[]) {
  return db.transaction((tx) => {
    if (holderOf(tx, req, own)) {
      throw new Error("its pages are held already");
    }
    const range = captureRange(req.map);
    const job = tx
      .insert(jobs)
      .values({
        ...req,
        billableSeconds: billableSeconds(
          req.preparedDurationSeconds,
          req.settings
        ),
        captureEnd: range && new Date(range.end),
        captureStart: range && new Date(range.start),
        settingsHash: settingsHash(req.settings),
      })
      .returning()
      .get();
    if (!job) {
      throw new Error("admission write lost");
    }
    const taken = tx
      .update(speechFragments)
      .set({ jobId: job.id, objectKey: null })
      .where(
        and(
          inArray(speechFragments.id, own),
          isNotNull(speechFragments.objectKey)
        )
      )
      .returning({ id: speechFragments.id })
      .all();
    if (taken.length < own.length) {
      throw new Error("fragments taken or withdrawn meanwhile");
    }
    logChange(tx, "job", job.id);
    return job;
  });
}

// What a withdrawal took: its rows' ids, the pages and source they held, and its audio's key.
export interface Withdrawn {
  ids: string[];
  key: string | null;
  pages: PageRanges | null;
  sourceId: string | null;
}

// Unsent audio leaves in one transaction: `take` deletes its rows and says what they held.
// The feed lists each id as a removed job with the first page, so the phone sends those pages again
// with no memory of the id (a row without pages, which no cutter job is, gives it nothing to send),
// and a raw-page source's cut goes back to them; then the object leaves the bucket. False when there was nothing to take.
export async function withdrawRows(
  db: Db,
  audio: AudioStore,
  take: (tx: Db) => Withdrawn | undefined
) {
  const gone = db.transaction((tx) => {
    const taken = take(tx);
    const first = taken?.pages?.[0]?.[0];
    if (taken && first !== undefined) {
      logChange(
        tx,
        "withdrawn",
        taken.ids.map((id) => `${id}:${first}:${taken.sourceId ?? ""}`)
      );
      // A raw-page source is cut here, not on a phone: its cursor moves back (page-processing.ts).
      tx.update(sources)
        .set({
          pagesCutFrom: sql`min(coalesce(${sources.pagesCutFrom}, ${first}), ${first})`,
        })
        .where(and(eq(sources.id, taken.sourceId ?? ""), hasRawPages()))
        .run();
    }
    return taken;
  });
  if (gone?.key) {
    await audio
      .delete(gone.key)
      .catch((error: unknown) => reportError(db, "withdrawn delete", error));
  }
  return gone !== undefined;
}
