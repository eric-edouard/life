// A thin phone's pages as sound: the packets each piece needs, labeled in the VAD worker
// (vad-worker.ts, one request at a time), and kept speech written back as Ogg Opus from the
// original packets.

import type { JobMap } from "@lifelog/db/schema";
import { pendantOggOpus } from "./audio";
import {
  type Interval,
  overlaps,
  PACKET_MS,
  type PlacedRun,
  runEnd,
} from "./page-rules";

// The packets of a page, by its index.
export type PacketsOf = (page: number) => Uint8Array[];
export interface Packet {
  at: number;
  data: Uint8Array;
}

// Each packet of `runs` that plays wholly inside [from, to), with when it starts, but those a quiet
// range touches: the owner's dictation is never decoded.
export function* packetsIn(
  runs: PlacedRun[],
  packetsOf: PacketsOf,
  [from, to]: Interval,
  quiet: Interval[] = []
) {
  for (const run of runs.filter((r) => r.start < to && runEnd(r) > from)) {
    const packets = packetsOf(run.page);
    for (let k = 0; k < run.packets; k += 1) {
      const at = run.start + k * PACKET_MS;
      const span: Interval = [at, at + PACKET_MS];
      if (
        at >= from &&
        span[1] <= to &&
        !quiet.some((q) => overlaps(q, span))
      ) {
        yield { at, data: packets[k] ?? new Uint8Array() };
      }
    }
  }
}

// One piece for Silero, from `start` (where its samples begin) through `end`: the packets that play
// there in time order, those just before `start` for the codec to converge. `stream` names the
// piece; `continues`: it goes on from where it reached in the worker (refused when the worker
// doesn't hold it); `final`: it ends at `end`, and the answer is every 32 ms frame's probability.
export interface LabelRequest {
  continues: boolean;
  end: number;
  final: boolean;
  packets: Packet[];
  start: number;
  stream: string;
}

// The worker, started on first use; it holds no process open. `lives` counts the workers that
// ended: a piece left open in one is gone, and is labeled again from its first page.
let worker: Worker | undefined;
let lives = 0;
export const workerLife = () => lives;
let chain: Promise<unknown> = Promise.resolve();
let nextId = 0;
// A final piece's labels: Silero's probability for each 32 ms frame, and each second's mean power.
export interface Labels {
  power: Float64Array;
  probabilities: Float32Array;
}
const waiting = new Map<
  number,
  { reject: (e: Error) => void; resolve: (l: Labels | null) => void }
>();

function started() {
  if (worker) {
    return worker;
  }
  const w = new Worker(new URL("./vad-worker.ts", import.meta.url).href);
  // Bun's Worker has `unref`; the DOM types it is declared with don't.
  (w as unknown as { unref: () => void }).unref();
  w.onmessage = ({ data }) => {
    const call = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) {
      call?.reject(new Error(data.error));
    } else {
      call?.resolve(data.labels);
    }
  };
  w.onerror = (event) => ended(w, event.message);
  w.addEventListener("close", () => ended(w, "it exited"));
  worker = w;
  return w;
}

// A crash or an exit settles every call waiting on it, so none hangs and the chain goes on.
function ended(w: Worker, why: string) {
  if (worker !== w) {
    return;
  }
  for (const call of waiting.values()) {
    call.reject(new Error(`VAD worker: ${why}`));
  }
  waiting.clear();
  worker = undefined;
  lives += 1;
  // A crash may leave it running: it is ended for good.
  w.terminate();
}

// Ends the worker (tests, and nothing else), as its exit would, but before stopWorker returns.
export function stopWorker() {
  if (worker) {
    ended(worker, "it was stopped");
  }
}

// Labels one piece, after every request before it: Silero runs one call at a time.
export function label(req: LabelRequest): Promise<Labels | null> {
  const run = chain.then(
    () =>
      new Promise<Labels | null>((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        waiting.set(id, { reject, resolve });
        started().postMessage({ ...req, id });
      })
  );
  chain = run.catch(() => undefined);
  return run;
}

// CELT's silence frame (16 kHz, 20 ms): the 0.4 s between kept stretches.
const SILENCE = new Uint8Array([0xb8, 0xff, 0xfe]);
const SEPARATOR_MS = 400;

// A fragment's audio from the original packets, no re-encoding: each segment narrowed to the
// whole packets inside it (never a packet of audio left out, such as a quiet range), split where
// packets don't follow each other, 0.4 s of silence between stretches. The map says where each
// plays. Null when no whole packet is kept.
export function fragmentAudio(
  segments: Interval[],
  runs: PlacedRun[],
  packetsOf: PacketsOf
) {
  const stretches: { packets: Uint8Array[]; span: Interval }[] = [];
  for (const segment of segments) {
    for (const { at, data } of packetsIn(runs, packetsOf, segment)) {
      const last = stretches.at(-1);
      if (last && last.span[1] === at) {
        last.span[1] = at + PACKET_MS;
        last.packets.push(data);
      } else {
        stretches.push({ packets: [data], span: [at, at + PACKET_MS] });
      }
    }
  }
  if (stretches.length === 0) {
    return null;
  }
  const separator = new Array<Uint8Array>(SEPARATOR_MS / PACKET_MS).fill(
    SILENCE
  );
  const packets = stretches.flatMap((s, i) =>
    i === 0 ? s.packets : [...separator, ...s.packets]
  );
  const map: JobMap = {
    segments: stretches.map((s) => s.span),
    separatorMs: SEPARATOR_MS,
  };
  return { audio: pendantOggOpus(packets, packets.length * PACKET_MS), map };
}
