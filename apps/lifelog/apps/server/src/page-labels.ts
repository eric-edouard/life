// Labels a raw-page source's speech (page-processing.ts runs it): the next stored pages, in index
// order, are placed in time, cut into pieces and labeled by Silero in the VAD worker; each piece is
// a `page_pieces` row and its pages are `labeled`. Only audio the Mac vouched for is labeled, and
// no packet a quiet range touches is ever decoded: the server's VAD never hears dictation. A piece
// still growing when a batch ends stays open in the worker and goes on with the next batch, as one
// piece would on the phone. A page stored after labeling passed it (a late page) is labeled on its
// own, and the cut goes back to it.

import type { Db } from "@lifelog/db";
import {
  PROCESSED_CODECS,
  pagePieces,
  rawPages,
  sources,
} from "@lifelog/db/schema";
import {
  and,
  asc,
  between,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  max,
  sql,
} from "drizzle-orm";
import type { AudioStore } from "./audio-store";
import { record } from "./events";
import { label, type PacketsOf, packetsIn, workerLife } from "./page-audio";
import {
  type CaptureSpan,
  energyAudible,
  type Interval,
  omiRecord,
  PACKET_MS,
  type Piece,
  type PlacedRun,
  pieces,
  placeOmi,
  runEnd,
  sileroSpeech,
  subtracting,
  unioned,
} from "./page-rules";
import { quietIn } from "./quiet-ranges";
import { type SpanFacts, saveSpans } from "./timeline-spans";

// A missing page is waited for this long (the phone sends its pages in order), then labeling
// goes on past it: a record the ring overwrote never comes.
const HOLE_WAIT_MS = 2 * 60_000;
// Decoding starts this early so the codec has converged (`SourceAudio.prerollPackets`).
const PREROLL_MS = 10 * PACKET_MS;

type Row = typeof rawPages.$inferSelect;

// The bytes of stored pages, read from their batch objects. Null when one is missing.
export async function pageBytes(audio: AudioStore, rows: Row[]) {
  const out = new Map<number, Uint8Array>();
  for (const [key, group] of Map.groupBy(rows, (r) => r.objectKey)) {
    // biome-ignore lint/performance/noAwaitInLoops: one batch object after the other
    const bytes = await audio.get(key);
    if (!bytes) {
      return null;
    }
    for (const r of group) {
      out.set(r.pageIndex, bytes.subarray(r.offset, r.offset + r.length));
    }
  }
  return out;
}

// Stored pages as records, ready to place: an unreadable page has no audio (a break).
export const records = (rows: Row[], bytes: Map<number, Uint8Array>) =>
  rows.map((r) => {
    const read = omiRecord(bytes.get(r.pageIndex) ?? new Uint8Array());
    const frames = read?.frames ?? [];
    return {
      frames,
      index: r.pageIndex,
      packets: frames.length,
      stampMs: read?.stampMs ?? null,
    };
  });

// The timeline spans (`FactsBuilder.spans`) whose first pages are `first` to `last`, from their
// pieces. Speech and audible clipped to the span, what no piece covers for a second or more
// unanalyzed, its first piece's breaks at its start, no pauses (an Omi confirms none).
function spansOf(tx: Db, sourceId: string, first: number, last: number) {
  const rows = tx
    .select()
    .from(pagePieces)
    .where(
      and(
        eq(pagePieces.sourceId, sourceId),
        between(pagePieces.spanFirst, first, last)
      )
    )
    .orderBy(asc(pagePieces.spanFirst), asc(pagePieces.firstPage))
    .all();
  return [...Map.groupBy(rows, (r) => r.spanFirst).values()].map(spanFacts);
}

type PieceRow = typeof pagePieces.$inferSelect;
// One span's facts from its pieces, in page order (never none: they were grouped by span). Speech
// and audible clipped to the span, what no piece covers for a second or more unanalyzed, its
// first piece's breaks at its start, no pauses (an Omi confirms none).
function spanFacts(group: PieceRow[]): SpanFacts {
  const covered = unioned(
    group.map((p): Interval => [p.startAt.getTime(), p.endAt.getTime()])
  );
  const span: Interval = [covered[0]?.[0] ?? 0, covered.at(-1)?.[1] ?? 0];
  const [head] = group;
  const at = (ms: number) => new Date(ms).toISOString();
  const iso = (ranges: Interval[]) =>
    ranges.map(([s, e]): [string, string] => [at(s), at(e)]);
  const within = (ranges: Interval[]) =>
    iso(subtracting([span], subtracting([span], unioned(ranges))));
  return {
    audible: within(group.flatMap((p) => p.audible)),
    breaks: (head?.breaks ?? [])
      .toSorted()
      .map((kind) => ({ at: at(span[0]), kind })),
    endAt: at(span[1]),
    firstPage: head?.spanFirst ?? 0,
    pauses: [],
    speech: within(group.flatMap((p) => p.speech)),
    startAt: at(span[0]),
    unanalyzed: iso(
      subtracting([span], covered).filter(([s, e]) => e - s >= 1000)
    ),
  };
}

// The packets of records read in index order, by page.
function framesOf(read: ReturnType<typeof records>): PacketsOf {
  const base = read[0]?.index ?? 0;
  return (page) => read[page - base]?.frames ?? [];
}

// Where the labels reach in capture time: the end of the latest piece.
export function labeledUntil(db: Pick<Db, "select">, sourceId: string) {
  return (
    db
      .select({ end: max(pagePieces.endAt) })
      .from(pagePieces)
      .where(eq(pagePieces.sourceId, sourceId))
      .get()?.end ?? null
  );
}

// Whether every stored Omi page of the source is labeled.
export const allLabeled = (db: Db, sourceId: string) =>
  !db
    .select({ index: rawPages.pageIndex })
    .from(rawPages)
    .where(and(eq(rawPages.sourceId, sourceId), unlabeled))
    .limit(1)
    .get();

const unlabeled = and(
  inArray(rawPages.codec, PROCESSED_CODECS),
  eq(rawPages.labeled, false)
);

// What one batch reads: contiguous pages, whether they came late (below a labeled page), whether
// the pages after them follow on (`more`), and whether a hole stopped it.
interface Batch {
  hole: boolean;
  late: boolean;
  more: boolean;
  take: Row[];
}

export function pageLabeler(
  db: Db,
  audio: AudioStore,
  {
    batchPages,
    now,
    vouched,
  }: { batchPages: number; now: () => number; vouched: () => number }
) {
  // Each source's open piece, its pages not marked labeled yet, and the worker life holding its
  // stream. Lost on a restart, a worker that ended or a refused call, it is labeled again from its
  // first page.
  const open = new Map<string, { life: number; piece: Piece }>();
  const openPiece = (sourceId: string) => {
    const held = open.get(sourceId);
    if (held && held.life !== workerLife()) {
      open.delete(sourceId);
    }
    return open.get(sourceId)?.piece;
  };

  const rowsFrom = (
    sourceId: string,
    after: number,
    below = Number.MAX_SAFE_INTEGER
  ) =>
    db
      .select()
      .from(rawPages)
      .where(
        and(
          eq(rawPages.sourceId, sourceId),
          unlabeled,
          gt(rawPages.pageIndex, after),
          lt(rawPages.pageIndex, below)
        )
      )
      .orderBy(asc(rawPages.pageIndex))
      .limit(batchPages)
      .all();

  // The highest labeled page, if any.
  const highestLabeled = (sourceId: string) =>
    db
      .select({ index: max(rawPages.pageIndex) })
      .from(rawPages)
      .where(and(eq(rawPages.sourceId, sourceId), eq(rawPages.labeled, true)))
      .get()?.index ?? null;

  // Late pages (unlabeled, below a labeled one), else the pages after the open piece or the last
  // labeled one (`after`).
  function candidates(sourceId: string) {
    const highest = highestLabeled(sourceId);
    const late = highest === null ? [] : rowsFrom(sourceId, -1, highest);
    const after = openPiece(sourceId)?.last ?? highest ?? -1;
    return late.length > 0
      ? { after, late: true, rows: late }
      : { after, late: false, rows: rowsFrom(sourceId, after) };
  }

  // The next batch: late pages first (unlabeled, below a labeled one), else the pages after the
  // open piece or the last labeled one, up to a hole, which is waited for first. Null when none
  // may go.
  function nextBatch(sourceId: string): Batch | null {
    const { after, late, rows } = candidates(sourceId);
    const [first] = rows;
    const hole = !late && after >= 0 && first?.pageIndex !== after + 1;
    const young = now() - (first?.receivedAt.getTime() ?? 0) < HOLE_WAIT_MS;
    if (!first || (hole && young)) {
      return null;
    }
    const take = rows.filter((r, i) => r.pageIndex === first.pageIndex + i);
    return {
      hole: take.length < rows.length,
      late,
      more: rows.length === batchPages && take.length === rows.length,
      take,
    };
  }

  // Runs only through what the Mac vouched for: the batch stops before the first page past it.
  // `truncated`: the span going on past the stop stays open.
  function vouchedOnly(take: Row[], spans: CaptureSpan[]) {
    const limit = vouched();
    const stop = spans
      .flatMap((s) => s.runs)
      .find((r) => runEnd(r) > limit)?.page;
    if (stop === undefined) {
      return { spans, take, truncated: false };
    }
    const keep = (r: PlacedRun) => r.page < stop;
    return {
      spans: spans
        .map((s) => ({ ...s, runs: s.runs.filter(keep) }))
        .filter((s) => s.runs.length > 0),
      take: take.filter((r) => r.pageIndex < stop),
      // A stop that starts a span ends the one before it: that one is whole.
      truncated: !spans.some((s) => s.runs[0]?.page === stop),
    };
  }

  // Labels `piece` in the worker; its row when it closes, null while it stays open.
  async function labelPiece(
    sourceId: string,
    piece: Piece,
    {
      carried,
      final,
      packets,
      runs,
    }: {
      carried: Piece | undefined;
      final: boolean;
      packets: PacketsOf;
      runs: PlacedRun[];
    }
  ) {
    const from = carried
      ? carried.end
      : piece.start - PREROLL_MS - PACKET_MS + 1;
    const reach: Interval = [from, piece.end + PACKET_MS];
    const labels = await label({
      continues: carried !== undefined,
      end: piece.end,
      final,
      packets: [...packetsIn(runs, packets, reach, quietIn(db, reach))],
      start: piece.start,
      stream: `${sourceId}#${piece.first}`,
    }).catch((error: unknown) => {
      // Its stream is gone: the piece is labeled again from its first page.
      open.delete(sourceId);
      throw error;
    });
    if (!labels) {
      open.set(sourceId, { life: workerLife(), piece });
      return null;
    }
    const millis = piece.end - piece.start;
    return {
      audible: energyAudible(labels.power, piece.start, millis),
      breaks: piece.breaks,
      endAt: new Date(piece.end),
      firstPage: piece.first,
      lastPage: piece.last,
      sourceId,
      spanFirst: piece.span,
      speech: sileroSpeech(labels.probabilities, piece.start, millis),
      startAt: new Date(piece.start),
    };
  }

  // The pieces written and their pages marked labeled, with the pages among them that held no
  // audio; the cut goes back to the first of them when they came late.
  function save(
    sourceId: string,
    rows: (typeof pagePieces.$inferInsert)[],
    [first, last]: [number, number],
    late: boolean
  ) {
    const moved = db.transaction((tx) => {
      if (rows.length > 0) {
        tx.insert(pagePieces).values(rows).onConflictDoNothing().run();
      }
      tx.update(rawPages)
        .set({ labeled: true })
        .where(
          and(
            eq(rawPages.sourceId, sourceId),
            gte(rawPages.pageIndex, first),
            lte(rawPages.pageIndex, last)
          )
        )
        .run();
      tx.insert(sources)
        .values({ id: sourceId, pagesCutFrom: first })
        .onConflictDoUpdate({
          set: {
            pagesCutFrom: late
              ? sql`min(coalesce(${sources.pagesCutFrom}, ${first}), ${first})`
              : sql`coalesce(${sources.pagesCutFrom}, ${first})`,
          },
          target: sources.id,
        })
        .run();
      // The spans these pieces are in, as grouping reads them.
      const pages = rows.map((r) => r.spanFirst);
      return pages.length > 0
        ? saveSpans(
            tx,
            sourceId,
            spansOf(tx, sourceId, Math.min(...pages), Math.max(...pages))
          )
        : [];
    });
    for (const fields of moved) {
      record(db, "job.span_moved", fields);
    }
    if (late) {
      record(db, "pages.late", { first, last, source: sourceId });
    }
  }

  // Where a batch goes on from: the open piece, else the last piece written. A late batch stands
  // alone, placed by its own stamps.
  function seedOf(sourceId: string, late: boolean) {
    const going = openPiece(sourceId);
    if (late || going) {
      return going && !late
        ? { end: going.end, page: going.last, span: going.span }
        : undefined;
    }
    const last = db
      .select()
      .from(pagePieces)
      .where(eq(pagePieces.sourceId, sourceId))
      .orderBy(desc(pagePieces.firstPage))
      .limit(1)
      .get();
    return (
      last && {
        end: last.endAt.getTime(),
        page: last.lastPage,
        span: last.spanFirst,
      }
    );
  }

  // The open piece closed as it stands: nothing more comes for it.
  async function close(sourceId: string) {
    const piece = openPiece(sourceId);
    if (!piece) {
      return;
    }
    open.delete(sourceId);
    const row = await labelPiece(sourceId, piece, {
      carried: piece,
      final: true,
      packets: () => [],
      runs: [],
    });
    save(sourceId, row ? [row] : [], [piece.first, piece.last], false);
  }

  // A batch's pages read and placed, through what the Mac vouched for. Null when none may go.
  async function place(sourceId: string, batch: Batch) {
    const bytes = await pageBytes(audio, batch.take);
    if (!bytes) {
      const page = batch.take[0]?.pageIndex ?? 0;
      record(db, "pages.unreadable", { page, source: sourceId });
      return null;
    }
    const read = records(batch.take, bytes);
    const seed = seedOf(sourceId, batch.late);
    const placed = vouchedOnly(batch.take, placeOmi(read, seed));
    const [head] = placed.take;
    const tail = placed.take.at(-1);
    return head && tail
      ? {
          ...placed,
          first: head.pageIndex,
          last: tail.pageIndex,
          packets: framesOf(read),
          seed,
        }
      : null;
  }

  // Labels `list` in order: its first piece goes on from `going`, its last stays open if `stays`.
  async function labelAll(
    sourceId: string,
    list: Piece[],
    {
      going,
      packets,
      runs,
      stays,
    }: {
      going: Piece | undefined;
      packets: PacketsOf;
      runs: PlacedRun[];
      stays: boolean;
    }
  ) {
    const rows: (typeof pagePieces.$inferInsert)[] = [];
    for (const [i, piece] of list.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: one piece at a time, in order
      const row = await labelPiece(sourceId, piece, {
        carried: i === 0 ? going : undefined,
        final: !(stays && i === list.length - 1),
        packets,
        runs,
      });
      rows.push(...(row ? [row] : []));
    }
    return rows;
  }

  // The open piece a batch goes on from, or none: one whose span the batch breaks closes first.
  async function goingOn(
    sourceId: string,
    late: boolean,
    spans: CaptureSpan[]
  ) {
    // A late batch stands alone: the open piece stays open, in its own stream.
    if (late) {
      return;
    }
    const carried = openPiece(sourceId);
    const going = spans[0]?.breaks.length === 0 ? carried : undefined;
    if (carried && !going) {
      await close(sourceId);
    }
    open.delete(sourceId);
    return going;
  }

  // Labels a placed batch: the open piece goes on when its span does (else it closes first), and
  // the last piece stays open while more of its span waits.
  async function labelPlaced(
    sourceId: string,
    batch: Batch,
    placed: NonNullable<Awaited<ReturnType<typeof place>>>
  ) {
    const going = await goingOn(sourceId, batch.late, placed.spans);
    // The first span goes on from the open piece, or from the last one written.
    const after = going ? undefined : placed.seed;
    const list = placed.spans.flatMap((s, i) =>
      i === 0 && s.breaks.length === 0 ? pieces(s, going, after) : pieces(s)
    );
    const stays = !batch.late && (batch.more || placed.truncated);
    const rows = await labelAll(sourceId, list, {
      going,
      packets: placed.packets,
      runs: placed.spans.flatMap((s) => s.runs),
      stays,
    });
    const kept = batch.late ? undefined : openPiece(sourceId)?.first;
    const end = kept ?? placed.last + 1;
    save(sourceId, rows, [going?.first ?? placed.first, end - 1], batch.late);
  }

  // Labels the next batch of a source; true when more wait.
  return async function labelBatch(sourceId: string) {
    const batch = nextBatch(sourceId);
    if (!batch) {
      await close(sourceId);
      return false;
    }
    const placed = await place(sourceId, batch);
    if (placed) {
      await labelPlaced(sourceId, batch, placed);
    }
    return Boolean(placed) && (batch.more || batch.late || batch.hole);
  };
}
