// The iPhone's rules, ported from Kit so a thin phone's pages become the same speech fragments
// (docs/processing.md, "Phones send pages"): an Omi record's frames (`OmiRecord`), where they
// play (`CaptureTimeline.spans`), the playback pieces Silero labels (`DerivedAudioWorker.pieces`,
// `SileroDetector.windows`), the audio kept (`SpeechPolicy.keptAudio`) and where a fragment ends
// (`SpeechFragment`). Pure: fixtures/pages holds a case Kit's PageProcessingParityTests run too.
// Instants are capture time, epoch ms; an interval is [start, end).

export type Interval = [number, number];

// Sorted and disjoint, overlapping or touching intervals joined, empty ones dropped.
export function unioned(ranges: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (start >= end) {
      continue;
    }
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

// `ranges` minus `cut`, both unioned. ponytail: each range scans every cut, fine for a window's
// few dozen intervals; walk both lists at once if whole days ever go through it.
export function subtracting(ranges: Interval[], cut: Interval[]): Interval[] {
  return ranges.flatMap(([start, end]) => {
    const out: Interval[] = [];
    let cursor = start;
    for (const [from, to] of cut.filter(([f, t]) => t > start && f < end)) {
      if (from > cursor) {
        out.push([cursor, from]);
      }
      cursor = Math.max(cursor, to);
    }
    return cursor < end ? [...out, [cursor, end] as Interval] : out;
  });
}

export const overlaps = (a: Interval, b: Interval) =>
  a[0] < b[1] && b[0] < a[1];
const length = ([start, end]: Interval) => end - start;

// An Omi ring record: a big-endian UTC second (bit 31 set: uptime, null here), then 20 ms Opus
// frames packed as [length][frame]; a zero byte is padding, and a length whose frame runs to the
// record's last byte ends it (`ring_protocol.dart`). Null when it isn't 444 bytes.
const OMI_RECORD_BYTES = 444;
export function omiRecord(bytes: Uint8Array) {
  if (bytes.length !== OMI_RECORD_BYTES) {
    return null;
  }
  const stamp = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const frames: Uint8Array[] = [];
  let offset = 4;
  while (offset < bytes.length - 1) {
    const size = bytes[offset] ?? 0;
    if (size === 0) {
      offset += 1;
      continue;
    }
    if (offset + 1 + size >= bytes.length) {
      break;
    }
    frames.push(bytes.subarray(offset + 1, offset + 1 + size));
    offset += size + 1;
  }
  return { frames, stampMs: stamp >= 0x80_00_00_00 ? null : stamp * 1000 };
}

export const PACKET_MS = 20;
// Packets this close to where the audio before ended continue it, back to back; a stretch
// without packets longer than a second ends the span.
const CONTINUITY_MS = 60;
const SILENCE_FILL_MS = 1000;
// An Omi stamp is a whole second (`DecodedPage.clockStepMillis`).
const OMI_STEP_MS = 1000;
// A clock at or before 2020 was never set (`ClockModel.earliestPlausibleMillis`).
const EARLIEST_MS = 1_577_836_800_000;

// One page's packets where they play: an Omi record's frames back to back from its stamp.
export interface PlacedRun {
  packets: number;
  page: number;
  start: number;
}
export const runEnd = (run: PlacedRun) => run.start + run.packets * PACKET_MS;

export interface CaptureSpan {
  // Why it doesn't continue the audio before (empty: it does, or it is the first).
  breaks: string[];
  runs: PlacedRun[];
}

// A page's stamp; null for one with no audio, or none to trust (`untimedPage`).
function stampOf(
  page: { packets: number; stampMs: number | null },
  breaks: Set<string>
) {
  if (page.packets === 0) {
    return null;
  }
  if (page.stampMs === null || page.stampMs <= EARLIEST_MS) {
    breaks.add("untimedPage");
    return null;
  }
  return page.stampMs;
}

// Where a run stamped `stamp` starts after audio ending at `end`, and why it breaks from it:
// jitter and overlaps start back to back; a short silence stays where the clock put it.
function follow(stamp: number, end: number | undefined, breaks: Set<string>) {
  if (end === undefined) {
    return stamp;
  }
  const jump = stamp - end;
  if (jump > SILENCE_FILL_MS + OMI_STEP_MS) {
    breaks.add("timeGap");
  }
  if (jump < -(CONTINUITY_MS + OMI_STEP_MS)) {
    breaks.add("overlap");
  }
  return jump <= CONTINUITY_MS + OMI_STEP_MS ? end : stamp;
}

// `CaptureTimeline.spans` for Omi records, in index order: frames play 20 ms apart from a run's
// first stamp, a record within a step of where the audio ended continues it, and a stamp jumping
// further starts again where it says. `after` is where the audio placed before ended (its last
// page and instant), so a batch goes on from it.
export function placeOmi(
  pages: { index: number; packets: number; stampMs: number | null }[],
  after?: { end: number; page: number }
) {
  const spans: CaptureSpan[] = [];
  let pending = new Set<string>();
  let previous = after?.page;
  let end = after?.end;
  for (const page of pages.toSorted((a, b) => a.index - b.index)) {
    if (previous !== undefined && previous + 1 < page.index) {
      pending.add("missingPages");
    }
    previous = page.index;
    const stamp = stampOf(page, pending);
    if (stamp === null) {
      continue;
    }
    const start = follow(stamp, end, pending);
    const run = { packets: page.packets, page: page.index, start };
    const last = spans.at(-1);
    if (last && pending.size === 0) {
      last.runs.push(run);
    } else {
      const first = spans.length === 0 && after === undefined;
      spans.push({ breaks: first ? [] : [...pending].sort(), runs: [run] });
      pending = new Set();
    }
    end = runEnd(run);
  }
  return spans;
}

// A playback piece Silero labels in one go: whole pages of one span, at most about 10 minutes,
// tiling the span (a short silence before a cut stays in the earlier piece). `open` is the piece the
// span goes on from, from an earlier batch: it grows first, as one piece would.
export interface Piece {
  // Why its span starts apart from the one before; the span's first piece carries them.
  breaks: string[];
  end: number;
  first: number;
  last: number;
  runs: PlacedRun[];
  // Its span, by the span's first page.
  span: number;
  start: number;
}
const PIECE_MS = 600_000;
// `after`: the closed piece the span goes on from (its end and span); its first new piece starts
// where that one ended, so the silence between them is in a piece, as on the phone.
// Whether `run` joins `piece`: the same page, or the piece stays within about 10 minutes.
const joins = (piece: Piece, run: PlacedRun) =>
  piece.last === run.page || runEnd(run) - piece.start <= PIECE_MS;

export function pieces(
  span: CaptureSpan,
  open?: Piece,
  after?: { end: number; span: number }
) {
  const out: Piece[] = open ? [{ ...open, runs: [...open.runs] }] : [];
  const id = open?.span ?? after?.span ?? span.runs[0]?.page ?? 0;
  for (const run of span.runs) {
    const last = out.at(-1);
    if (last && joins(last, run)) {
      last.last = run.page;
      last.end = runEnd(run);
      last.runs.push(run);
      continue;
    }
    if (last) {
      last.end = run.start;
    }
    const first = out.length === 0;
    out.push({
      breaks: first ? span.breaks : [],
      end: runEnd(run),
      first: run.page,
      last: run.page,
      runs: [run],
      span: id,
      start: first && after ? after.end : run.start,
    });
  }
  return out;
}

// The energy detector's audible seconds (`EnergyDetector`, the level of 1 s windows from the
// piece's start, a shorter last one): -50 dB or more is sound, speech or not, as one interval list.
const AUDIBLE_DB = -50;
export function energyAudible(
  power: ArrayLike<number>,
  start: number,
  millis: number
) {
  const audible: Interval[] = [];
  for (let k = 0; k < power.length && k * 1000 < millis; k += 1) {
    if (10 * Math.log10(Math.max(power[k] ?? 0, 1e-12)) >= AUDIBLE_DB) {
      audible.push([
        start + k * 1000,
        start + Math.min((k + 1) * 1000, millis),
      ]);
    }
  }
  return unioned(audible);
}

// Silero's 32 ms frame probabilities as speech: 1 s windows from the piece's start, each speech
// with 8 frames (256 ms) at 0.3 or more (as float32, Kit's `Float`).
export const SILERO_FRAME = 512;
const FRAME_MS = 32;
const THRESHOLD = Math.fround(0.3);
const MIN_SPEECH_FRAMES = 8;
export function sileroSpeech(
  probabilities: ArrayLike<number>,
  start: number,
  millis: number
) {
  const speech: Interval[] = [];
  for (let from = 0; from < millis; from += 1000) {
    const to = Math.min(from + 1000, millis);
    const first = Math.min(probabilities.length, Math.ceil(from / FRAME_MS));
    const last = Math.min(probabilities.length, Math.ceil(to / FRAME_MS));
    let frames = 0;
    for (let i = first; i < last; i += 1) {
      frames += (probabilities[i] ?? 0) >= THRESHOLD ? 1 : 0;
    }
    if (frames >= MIN_SPEECH_FRAMES) {
      speech.push([start + from, start + to]);
    }
  }
  return unioned(speech);
}

// `SpeechPolicy.keptAudio`: speech padded 1 s each side, audio no analyzer reached (pieces of a
// second or more) counted as speech, gaps under 3 s kept, inside the spans, quiet ranges left out.
const PADDING_MS = 1000;
const MINIMUM_CUT_MS = 3000;
export function keptAudio(
  spans: Interval[],
  speech: Interval[],
  analyzed: Interval[],
  quiet: Interval[]
) {
  const audio = unioned(spans);
  const padded = speech.map(
    ([start, end]): Interval => [start - PADDING_MS, end + PADDING_MS]
  );
  const unanalyzed = subtracting(audio, unioned(analyzed)).filter(
    (r) => length(r) >= 1000
  );
  const kept: Interval[] = [];
  for (const range of unioned([...padded, ...unanalyzed])) {
    const last = kept.at(-1);
    if (last && range[0] - last[1] < MINIMUM_CUT_MS) {
      last[1] = range[1];
    } else {
      kept.push(range);
    }
  }
  return subtracting(
    subtracting(audio, subtracting(audio, kept)),
    unioned(quiet)
  );
}

// `SpeechFragment`: stretches under half a second hold no word; a minute of speech with no pause
// is cut in a non-speech second; a fragment holds at most 90 s.
const MIN_SEGMENT_MS = 500;
const WAITING_MS = 60_000;
const FORCED_MS = 90_000;

export interface Fragment {
  last: number;
  pages: [number, number][];
  segments: Interval[];
}

// Each page's end: the index of its last run, and where it ends.
const pageEnds = (runs: PlacedRun[]) =>
  runs.flatMap((run, i): [number, number][] =>
    runs[i + 1]?.page === run.page ? [] : [[i, runEnd(run)]]
  );

// Kept audio before `end`, in ms.
const keptBefore = (kept: Interval[], end: number) =>
  kept.reduce(
    (sum, [start, stop]) => sum + Math.max(0, Math.min(stop, end) - start),
    0
  );

// A pause at `end`: outside kept audio, with kept audio after it or `heard` past it.
const isPause = (kept: Interval[], end: number, heard: number | null) =>
  !kept.some(([start, stop]) => start < end && end < stop) &&
  (kept.some(([start]) => start >= end) || (heard !== null && end <= heard));

// The fragment that starts with the first of `runs` (in time order), or null while its speech
// may still grow. It ends at a page's end, within 90 s of kept speech: at the last pause (outside
// kept audio, with kept audio after it or `heard` past it); else, with a minute of speech
// waiting, inside the latest second `speech` doesn't cover; else at 90 s.
export function nextFragment(
  kept: Interval[],
  runs: PlacedRun[],
  speech: Interval[],
  heard: number | null
): Fragment | null {
  let pause: number | null = null;
  let quiet: number | null = null;
  let full: number | null = null;
  let waiting = 0;
  for (const [index, end] of pageEnds(runs)) {
    waiting = keptBefore(kept, end);
    if (waiting <= 0) {
      continue;
    }
    if (isPause(kept, end, heard)) {
      pause = index;
    }
    if (!speech.some(([start, stop]) => start <= end && end <= stop)) {
      quiet = index;
    }
    if (waiting >= FORCED_MS) {
      full = index;
      break;
    }
  }
  const cut = pause ?? (waiting >= WAITING_MS ? quiet : null) ?? full;
  const at = cut === null ? undefined : runs[cut];
  if (cut === null || !at) {
    return null;
  }
  const end = runEnd(at);
  const segments = kept
    .filter(([start]) => start < end)
    .map(([start, stop]): Interval => [start, Math.min(stop, end)])
    .filter((s) => length(s) >= MIN_SEGMENT_MS);
  return {
    last: at.page,
    pages: pagesOf(segments, runs.slice(0, cut + 1)),
    segments,
  };
}

// `SpeechFragment.unheld`: `kept` and `runs` without the held pages and their audio; kept time no
// free page plays, or under half a second, goes too.
export function unheld(
  kept: Interval[],
  runs: PlacedRun[],
  held: (page: number) => boolean
) {
  const taken = unioned(
    runs.filter((r) => held(r.page)).map((r): Interval => [r.start, runEnd(r)])
  );
  const free = runs.filter((r) => !held(r.page));
  const left = subtracting(unioned(kept), taken).filter(
    (piece) =>
      length(piece) >= MIN_SEGMENT_MS &&
      free.some((r) => overlaps(piece, [r.start, runEnd(r)]))
  );
  return { kept: left, runs: free };
}

// The pages whose packets play inside `segments`, as inclusive ranges.
export function pagesOf(segments: Interval[], runs: PlacedRun[]) {
  const pages = [
    ...new Set(
      runs
        .filter((r) => segments.some((s) => overlaps(s, [r.start, runEnd(r)])))
        .map((r) => r.page)
    ),
  ].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const page of pages) {
    const last = ranges.at(-1);
    if (last && last[1] + 1 === page) {
      last[1] = page;
    } else {
      ranges.push([page, page]);
    }
  }
  return ranges;
}
