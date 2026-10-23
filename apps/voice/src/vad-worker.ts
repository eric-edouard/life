// The VAD worker (a Bun Worker, page-audio.ts starts it): Opus packets decoded to 16 kHz by
// opus-decoder (libopus in WASM) and labeled by Silero VAD v6 on onnxruntime-web's WASM runtime,
// off the server's thread. Its own globals hold the runtime's Emscripten glue. One request at a time,
// in order; a piece that goes on in the next batch keeps its decoder and Silero's state here (its
// stream), so labels never restart where a batch ends (docs/voice/decisions.md, "A thin phone's pages").
import { env, InferenceSession, Tensor } from "onnxruntime-web";
// biome-ignore lint/performance/noNamespaceImport: `bun build --compile` drops the named export
import * as opus from "opus-decoder";
import modelFile from "../models/silero-vad-v6.0-16k.onnx" with {
  type: "file",
};
import type { LabelRequest } from "./page-audio";
import { SILERO_FRAME as FRAME, PACKET_MS } from "./page-rules";

const { OpusDecoder } = opus;
const SAMPLES_PER_MS = 16;
const SAMPLES_PER_PACKET = 320;
const CONTEXT = 64;

// The runtime's WASM and glue: embedded in the compiled server (scripts/build-host.ts), else the
// package's own files.
const embedded = (name: string) =>
  Bun.embeddedFiles.find((f) => (f as File).name === name);
let session: Promise<InferenceSession> | undefined;
function silero() {
  session ??= (async () => {
    env.logLevel = "error";
    env.wasm.numThreads = 1;
    const wasm = embedded("ort-wasm-simd-threaded.wasm");
    const glue = embedded("ort-wasm-simd-threaded.mjs");
    if (wasm && glue) {
      env.wasm.wasmBinary = await wasm.bytes();
      env.wasm.wasmPaths = {
        mjs: URL.createObjectURL(
          new Blob([await glue.text()], { type: "text/javascript" })
        ),
      };
    }
    return InferenceSession.create(await Bun.file(modelFile).bytes());
  })();
  return session;
}

// A piece being labeled: its decoder, where its samples reach, Silero's state and context, the
// samples short of a frame, every frame's probability so far, and each second's sum of squares
// and sample count (the energy detector's level).
interface Stream {
  context: Float32Array;
  counts: number[];
  decodedUntil: number | null;
  decoder: InstanceType<typeof OpusDecoder>;
  pending: Float32Array;
  probabilities: number[];
  squares: number[];
  start: number;
  state: Tensor;
  written: number;
}
const streams = new Map<string, Stream>();

async function stream(req: LabelRequest) {
  const going = streams.get(req.stream);
  if (req.continues) {
    if (!going) {
      throw new Error(`no piece ${req.stream} to go on with`);
    }
    return going;
  }
  going?.decoder.free();
  const decoder = new OpusDecoder({ channels: 1, sampleRate: 16_000 });
  await decoder.ready;
  const fresh: Stream = {
    context: new Float32Array(CONTEXT),
    counts: [],
    decodedUntil: null,
    decoder,
    pending: new Float32Array(),
    probabilities: [],
    squares: [],
    start: req.start,
    state: new Tensor("float32", new Float32Array(256), [2, 1, 128]),
    written: req.start,
  };
  streams.set(req.stream, fresh);
  return fresh;
}

// Samples of [s.written, end): each packet where it plays, silence where none does (and where a
// quiet range kept a packet from ever coming here); a packet that doesn't follow the one before
// starts a new decoder, and one the codec refuses is silence (`SourceAudio.samples`).
async function decode(
  s: Stream,
  packets: LabelRequest["packets"],
  end: number
) {
  const samples = new Float32Array((end - s.written) * SAMPLES_PER_MS);
  for (const { at, data } of packets) {
    if (s.decodedUntil !== at) {
      // biome-ignore lint/performance/noAwaitInLoops: the codec's state is the packets before
      await s.decoder.reset();
    }
    s.decodedUntil = at + PACKET_MS;
    const pcm = s.decoder
      .decodeFrame(data)
      .channelData[0]?.subarray(0, SAMPLES_PER_PACKET);
    const offset = (at - s.written) * SAMPLES_PER_MS;
    const first = Math.max(0, -offset);
    const last = Math.min(pcm?.length ?? 0, samples.length - offset);
    if (pcm && first < last) {
      samples.set(pcm.subarray(first, last), offset + first);
    }
  }
  s.written = end;
  return samples;
}

// Silero over every whole frame of `samples` after what was short of one, from the stream's state.
async function score(s: Stream, samples: Float32Array) {
  const model = await silero();
  const all = new Float32Array(s.pending.length + samples.length);
  all.set(s.pending);
  all.set(samples, s.pending.length);
  const sr = new Tensor("int64", BigInt64Array.from([16_000n]), []);
  const frames = Math.floor(all.length / FRAME);
  for (let f = 0; f < frames; f += 1) {
    const frame = all.subarray(f * FRAME, (f + 1) * FRAME);
    const input = new Float32Array(CONTEXT + FRAME);
    input.set(s.context);
    input.set(frame, CONTEXT);
    // biome-ignore lint/performance/noAwaitInLoops: each frame's state is the one before's
    const out = await model.run({
      input: new Tensor("float32", input, [1, input.length]),
      sr,
      state: s.state,
    });
    s.probabilities.push(Number(out.output?.data[0] ?? 0));
    s.state = out.stateN as Tensor;
    s.context = frame.slice(FRAME - CONTEXT);
  }
  s.pending = all.slice(frames * FRAME);
}

// Each second's sum of squares and count, from the piece's start (`EnergyDetector.windows`: 1 s
// windows, a shorter last one).
function measure(s: Stream, samples: Float32Array, from: number) {
  const first = (from - s.start) * SAMPLES_PER_MS;
  for (let i = 0; i < samples.length; i += 1) {
    const second = Math.floor((first + i) / (1000 * SAMPLES_PER_MS));
    const x = samples[i] ?? 0;
    s.squares[second] = (s.squares[second] ?? 0) + x * x;
    s.counts[second] = (s.counts[second] ?? 0) + 1;
  }
}

// Labels a piece's audio through `end`. A final piece's trailing partial frame is padded with
// silence (`SileroDetector.windows`), and its frames' probabilities and its seconds' mean power
// answered; an open one answers null.
async function label(req: LabelRequest) {
  const s = await stream(req);
  const from = s.written;
  const samples = await decode(s, req.packets, req.end);
  measure(s, samples, from);
  await score(s, samples);
  if (!req.final) {
    return null;
  }
  if (s.pending.length > 0) {
    await score(s, new Float32Array(FRAME - s.pending.length));
  }
  s.decoder.free();
  streams.delete(req.stream);
  return {
    power: Float64Array.from(s.squares, (sum, i) => sum / (s.counts[i] || 1)),
    probabilities: Float32Array.from(s.probabilities),
  };
}

declare const self: Worker;
self.onmessage = async (event: MessageEvent<LabelRequest & { id: number }>) => {
  const { id } = event.data;
  try {
    postMessage({ id, labels: await label(event.data) });
  } catch (error) {
    postMessage({ error: String(error), id });
  }
};
