// A thin phone's raw pages (pages.ts) become speech fragments on the server, by the iPhone's rules
// (page-rules.ts; docs/processing.md, "Phones send pages"). Each source gets bounded passes, which
// the tick, every stored batch and every word from the Mac start (`poke`):
// 1. Label (page-labels.ts): the next pages placed in time and labeled by Silero.
//    Its timeline spans (timeline-spans.ts) are written from the pieces, as the iPhone sends its own.
// 2. Cut: from `sources.pagesCutFrom`, the kept speech of pages no job or fragment holds becomes
//    fragments (`SpeechFragment.next`) stored through cutter.ts `storeFragment`, the same door the
//    iPhone's uploads use, so `holderOf`, the quiet ranges, `claim`, blocks and paid-once hold
//    unchanged. The cursor moves by compare-and-set: a fragment withdrawn meanwhile moved it back
//    (cutter.ts `withdrawRows`), and a late page does too.
// This is the one writer of a page source's heard-through and sent-through; the iPhone's timeline
// writes its own sources' (routes/timeline.ts).

import type { Db } from "@life/voice-db";
import {
  hasRawPages,
  holdsPages,
  transcriptionJobs as jobs,
  pagePieces,
  rawPages,
  sources,
  speechFragments,
} from "@life/voice-db/schema";
import {
  and,
  asc,
  type Column,
  eq,
  gt,
  gte,
  isNull,
  lt,
  max,
} from "drizzle-orm";
import type { AudioStore } from "./audio-store";
import { sha256Hex, singleFlight } from "./config";
import { storeFragment } from "./cutter";
import { record } from "./events";
import { regroupAfterCommit } from "./grouping";
import { fragmentAudio, type PacketsOf } from "./page-audio";
import {
  allLabeled,
  labeledUntil,
  pageBytes,
  pageLabeler,
  records,
} from "./page-labels";
import {
  type Fragment,
  type Interval,
  keptAudio,
  nextFragment,
  type PlacedRun,
  placeOmi,
  runEnd,
  unheld,
  unioned,
} from "./page-rules";
import { quietIn } from "./quiet-ranges";

// Capture read at once while cutting (`Uploader.windowMillis`), and fragments stored in one pass.
const WINDOW_MS = 3_600_000;
const FRAGMENTS_PER_PASS = 20;
// The record being written and the drain's edge (`FactsBuilder.savedMarginMillis`): speech going
// on at the newest audio never ends a fragment.
const MARGIN_MS = 3000;
// Nothing new for this long and everything labeled: the device was quiet, so its newest audio is
// heard through (`FactsBuilder.quietAllowanceMillis`).
const QUIET_MS = 10 * 60_000;
// `TimelineScanner.kept(in:)`: a margin wide enough that nothing outside changes what is kept.
const KEPT_MARGIN_MS = 5000;
// How far a page held past the window's end may play (a page is a fraction of a second).
const PAGE_REACH_MS = 60_000;

type PieceRow = typeof pagePieces.$inferSelect;
type Loaded = Map<
  string,
  { packets: Map<number, Uint8Array[]>; runs: PlacedRun[] }
>;
type Step =
  | { kind: "moved"; page: number; stored: boolean }
  | { kind: "wider" }
  | { kind: "stop"; waiting: number | null }
  | { kind: "held"; waiting: number | null };

// No fragment yet: nothing kept in whole pages moves the cursor past them; else a wider window,
// or, at the labeled end, it stops and the speech waits.
function withoutFragment(
  w: { complete: PlacedRun[]; free: { kept: Interval[] } },
  cursor: number,
  atEnd: boolean,
  waiting: number | null
): Step {
  const last = Math.max(-1, ...w.complete.map((r) => r.page));
  if (w.free.kept.length === 0 && w.complete.length > 0) {
    return last < cursor
      ? { kind: "stop", waiting: null }
      : { kind: "moved", page: last + 1, stored: false };
  }
  return atEnd ? { kind: "stop", waiting } : { kind: "wider" };
}

export function pageProcessor(
  db: Db,
  audio: AudioStore,
  worker: { poke: () => void },
  {
    batchPages = 3000,
    now = () => Date.now(),
    // The Mac's watermark: nothing after it is labeled (mac-socket.ts `vouchedThrough`).
    vouched = () => Number.POSITIVE_INFINITY,
  }: {
    batchPages?: number;
    now?: () => number;
    vouched?: () => number;
  } = {}
) {
  const labelBatch = pageLabeler(db, audio, { batchPages, now, vouched });
  let afterRegroup: () => void = () => undefined;

  // A piece's runs placed again (its pages play from its start as their stamps say) and their
  // packets, read once a pass.
  async function runsOf(piece: PieceRow, loaded: Loaded) {
    const key = `${piece.sourceId}/${piece.firstPage}`;
    const known = loaded.get(key);
    if (known) {
      return known;
    }
    const rows = db
      .select()
      .from(rawPages)
      .where(
        and(
          eq(rawPages.sourceId, piece.sourceId),
          gte(rawPages.pageIndex, piece.firstPage),
          lt(rawPages.pageIndex, piece.lastPage + 1)
        )
      )
      .orderBy(asc(rawPages.pageIndex))
      .all();
    const bytes = await pageBytes(audio, rows);
    if (!bytes) {
      throw new Error(`pages of piece ${key} are not in the audio store`);
    }
    const read = records(rows, bytes);
    const runs = placeOmi(read, {
      end: piece.startAt.getTime(),
      page: piece.firstPage - 1,
    }).flatMap((s) => s.runs);
    const out = {
      packets: new Map(read.map((r) => [r.index, r.frames])),
      runs,
    };
    loaded.set(key, out);
    return out;
  }

  const cursorOf = (sourceId: string) =>
    db
      .select({ at: sources.pagesCutFrom })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .get()?.at ?? null;
  // Compare-and-set: false when the cursor moved meanwhile (a withdrawal, a late page).
  const save = (sourceId: string, from: number, to: number) =>
    db
      .update(sources)
      .set({ pagesCutFrom: to })
      .where(and(eq(sources.id, sourceId), eq(sources.pagesCutFrom, from)))
      .returning({ id: sources.id })
      .all().length > 0;
  // Pieces from `page` on, starting before `until`.
  const piecesFrom = (sourceId: string, page: number, until: number) =>
    db
      .select()
      .from(pagePieces)
      .where(
        and(
          eq(pagePieces.sourceId, sourceId),
          gte(pagePieces.lastPage, page),
          lt(pagePieces.startAt, new Date(until))
        )
      )
      .orderBy(asc(pagePieces.firstPage));

  // The page ranges a job or an open fragment holds among `pages`, near [from, until).
  function heldIn(
    sourceId: string,
    pages: [number, number],
    [from, until]: Interval
  ) {
    const wanted = [pages];
    // From the window's start on (an index on the end): the archive before it is never read.
    const near = (start: Column, end: Column) =>
      and(gt(end, new Date(from)), lt(start, new Date(until + PAGE_REACH_MS)));
    const held = [
      ...db
        .select({ pages: jobs.pages })
        .from(jobs)
        .where(
          and(
            eq(jobs.sourceId, sourceId),
            near(jobs.captureStart, jobs.captureEnd),
            holdsPages("transcription_jobs", wanted)
          )
        )
        .all(),
      ...db
        .select({ pages: speechFragments.pages })
        .from(speechFragments)
        .where(
          and(
            eq(speechFragments.sourceId, sourceId),
            isNull(speechFragments.jobId),
            near(speechFragments.captureStart, speechFragments.captureEnd),
            holdsPages("speech_fragments", wanted)
          )
        )
        .all(),
    ];
    return held.flatMap((h) => h.pages ?? []);
  }

  // What `Uploader.sendSpeech` reads of `span` ms of capture from the cursor's page: the runs of
  // whole pages, the kept audio a little past them (so speech going on across their end shows)
  // without the pages the server holds, and the speech. Null when nothing from it is labeled.
  async function windowAt(
    sourceId: string,
    cursor: number,
    { end, loaded, span }: { end: number; loaded: Loaded; span: number }
  ) {
    const head = piecesFrom(sourceId, cursor, end).limit(1).get();
    const from =
      head &&
      (await runsOf(head, loaded)).runs.find((r) => r.page >= cursor)?.start;
    if (from === undefined || from >= end) {
      return null;
    }
    const until = Math.min(from + span, end);
    const window = piecesFrom(sourceId, cursor, until).all();
    const loadedRuns = await Promise.all(window.map((p) => runsOf(p, loaded)));
    const all = loadedRuns.flatMap((l) => l.runs);
    // Whole pages only: one still playing at the window's end waits for a wider window.
    const open = new Set(
      all.filter((r) => runEnd(r) > until).map((r) => r.page)
    );
    const complete = all.filter((r) => !open.has(r.page));
    const whole = Math.max(from, ...complete.map(runEnd));
    const reach = Math.min(whole + 10_000, end);
    const last = Math.max(cursor, ...all.map((r) => r.page));
    const ranges = heldIn(sourceId, [cursor, last], [from, until]);
    const held = (page: number) =>
      page < cursor || ranges.some(([a, z]) => a <= page && page <= z);
    const free = unheld(
      from < reach ? keptIn(sourceId, [from, reach]) : [],
      all,
      held
    );
    const packets: PacketsOf = (page) =>
      loadedRuns.find((l) => l.packets.has(page))?.packets.get(page) ?? [];
    return {
      complete,
      free,
      packets,
      runs: free.runs.filter((r) => !open.has(r.page)),
      speech: unioned(
        window
          .flatMap((p) => p.speech)
          .filter(([s, e]) => s < whole && e > from)
      ),
      until,
    };
  }

  // A fragment's audio stored through the cutter's door: "empty" when no whole packet is kept.
  async function send(
    sourceId: string,
    fragment: Fragment,
    { packets, runs }: { packets: PacketsOf; runs: PlacedRun[] }
  ) {
    const rendered = fragmentAudio(fragment.segments, runs, packets);
    if (!rendered) {
      return "empty" as const;
    }
    const result = await storeFragment(
      db,
      audio,
      {
        audioSha256: sha256Hex(rendered.audio),
        map: rendered.map,
        pages: fragment.pages,
        sourceId,
      },
      rendered.audio
    );
    if (typeof result === "string") {
      return result;
    }
    worker.poke();
    return "stored" as const;
  }

  // One step of `Uploader.sendSpeech` from `cursor`: a fragment stored (or nothing kept in whole
  // pages) moves the cursor to `page`; or the window widens; or it stops, with where the first
  // kept second not sent starts (null: none waits).
  async function step(
    sourceId: string,
    cursor: number,
    opts: {
      end: number;
      heard: number | null;
      loaded: Loaded;
      room: boolean;
      span: number;
    }
  ): Promise<Step> {
    const w = await windowAt(sourceId, cursor, opts);
    if (!w) {
      return { kind: "stop", waiting: null };
    }
    const fragment = nextFragment(w.free.kept, w.runs, w.speech, opts.heard);
    const waiting = w.free.kept[0]?.[0] ?? null;
    if (!fragment) {
      return withoutFragment(w, cursor, opts.end === w.until, waiting);
    }
    const outcome = opts.room
      ? await send(sourceId, fragment, w)
      : "unavailable";
    if (outcome === "unavailable" || outcome === "held") {
      return { kind: outcome === "held" ? "held" : "stop", waiting } as Step;
    }
    return {
      kind: "moved",
      page: fragment.last + 1,
      stored: outcome === "stored",
    };
  }

  // `Uploader.sendSpeech`: kept speech from the cursor on, an hour of capture read at a time,
  // around the pages the server holds, at most 20 fragments a pass. Returns where the first kept
  // second not sent starts (null: none waits).
  async function cut(sourceId: string, heard: number | null, end: number) {
    const loaded: Loaded = new Map();
    let span = WINDOW_MS;
    let refused: number | null = null;
    let stored = 0;
    for (
      let cursor = cursorOf(sourceId);
      cursor !== null;
      cursor = cursorOf(sourceId)
    ) {
      const room = stored < FRAGMENTS_PER_PASS;
      // biome-ignore lint/performance/noAwaitInLoops: the window moves with each fragment
      const next = await step(sourceId, cursor, {
        end,
        heard,
        loaded,
        room,
        span,
      });
      if (next.kind === "stop") {
        return next.waiting;
      }
      if (next.kind === "held") {
        // The pages held changed meanwhile: read them again once.
        if (refused === cursor) {
          record(db, "pages.held", { page: cursor, source: sourceId });
          return next.waiting;
        }
        refused = cursor;
      } else if (next.kind === "wider") {
        span += WINDOW_MS;
      } else {
        stored += next.stored ? 1 : 0;
        // A miss reads the cursor again: a withdrawal took it back meanwhile.
        save(sourceId, cursor, next.page);
        span = WINDOW_MS;
      }
    }
    return null;
  }

  // `TimelineScanner.kept(in:)`: the pieces near `range` as spans and labels, the quiet ranges cut.
  function keptIn(sourceId: string, [start, end]: Interval) {
    const wide: Interval = [start - KEPT_MARGIN_MS, end + KEPT_MARGIN_MS];
    const near = db
      .select()
      .from(pagePieces)
      .where(
        and(
          eq(pagePieces.sourceId, sourceId),
          lt(pagePieces.startAt, new Date(wide[1] + 1000)),
          gt(pagePieces.endAt, new Date(wide[0] - 1000))
        )
      )
      .all();
    const quiet = quietIn(db, [start, end]);
    const intervals = near.map(
      (p): Interval => [p.startAt.getTime(), p.endAt.getTime()]
    );
    return keptAudio(
      intervals.map(
        ([s, e]): Interval => [Math.max(s, wide[0]), Math.min(e, wide[1])]
      ),
      near.flatMap((p) => p.speech),
      intervals,
      quiet
    )
      .map(([s, e]): Interval => [Math.max(s, start), Math.min(e, end)])
      .filter(([s, e]) => s < e);
  }

  // Heard-through: the labeled audio less the margin, or all of it once every page is labeled
  // and the source has sent nothing for 10 minutes; never back.
  function heardThrough(sourceId: string, end: number) {
    const before = db
      .select({ heard: sources.heardThrough })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .get()?.heard;
    const newest = db
      .select({ received: max(rawPages.receivedAt) })
      .from(rawPages)
      .where(eq(rawPages.sourceId, sourceId))
      .get()?.received;
    const quiet =
      allLabeled(db, sourceId) &&
      now() - (newest?.getTime() ?? now()) >= QUIET_MS;
    return Math.max(before?.getTime() ?? 0, quiet ? end : end - MARGIN_MS);
  }

  const pass = singleFlight<string>(async (sourceId) => {
    const more = await labelBatch(sourceId);
    const end = labeledUntil(db, sourceId)?.getTime();
    if (end !== undefined) {
      const heard = heardThrough(sourceId, end);
      const sent = await cut(sourceId, heard, end);
      db.update(sources)
        .set({
          heardThrough: new Date(heard),
          sentThrough: new Date(sent ?? heard),
        })
        .where(eq(sources.id, sourceId))
        .run();
      // What it sent through may close a block (cutter.ts); the spans labeling wrote, and
      // heard-through, regroup its conversations (grouping.ts), as the iPhone's timeline does.
      worker.poke();
      regroupAfterCommit(db, [sourceId]);
      afterRegroup();
    }
    // Another round once this one ends (`singleFlight`), so a backlog goes on without a wait.
    if (more) {
      pass(sourceId).catch(() => undefined);
    }
  });

  // Every source with raw pages, one pass each.
  const run = () =>
    Promise.all(
      db
        .select({ id: sources.id })
        .from(sources)
        .where(hasRawPages())
        .all()
        .map((s) => pass(s.id))
    );
  return {
    idle: pass.idle,
    // What follows a regroup (services.ts: chapters, waiting reasons).
    onRegrouped(then: () => void) {
      afterRegroup = then;
    },
    // A pass for `sourceId`, or every page source; a failure is logged.
    poke(sourceId?: string) {
      (sourceId === undefined ? run() : pass(sourceId)).catch(
        (error: unknown) => console.error(`page processing: ${String(error)}`)
      );
    },
    run,
  };
}

export type PageProcessor = ReturnType<typeof pageProcessor>;
