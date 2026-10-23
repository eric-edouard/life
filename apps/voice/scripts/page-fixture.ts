// Writes fixtures/pages: made-up Omi ring records (macOS `say` speech and quiet noise, never the
// owner's audio) encoded as the Omi does (Opus CELT, 16 kHz mono, 20 ms, 32 kbps), packed 444 bytes
// a record with whole-second stamps. The server's page-processing test and Kit's
// PageProcessingParityTests read them; WRITE_PAGES=1 on Kit's test writes the expected output.
//   bun apps/voice/scripts/page-fixture.ts   (macOS, ffmpeg)
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { oggOpusPackets } from "../src/audio";

const out = resolve(import.meta.dir, "../../../fixtures/pages");
const RATE = 16_000;
// 2026-10-12T10:00:00Z: the first span's first sample, after the first quiet range (cutter.ts).
const T0 = 1_791_799_200_000;
const GAP_MS = 40_000;

const dir = await mkdtemp(join(tmpdir(), "page-fixture-"));
// A sentence spoken by `say`, as 16 kHz mono floats.
async function speech(text: string) {
  const aiff = join(dir, "say.aiff");
  await $`say -v Samantha -o ${aiff} ${text}`.quiet();
  const raw =
    await $`ffmpeg -v error -i ${aiff} -ac 1 -ar ${RATE} -f f32le -`.arrayBuffer();
  return new Float32Array(raw);
}
// Quiet room noise, the same every run.
let seed = 1;
const quiet = (seconds: number) =>
  Float32Array.from({ length: seconds * RATE }, () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (seed / 2_147_483_648 - 0.5) * 0.002;
  });

const spans = [
  [
    quiet(3),
    await speech("The quick brown fox jumps over the lazy dog by the river."),
    quiet(6),
    await speech("Then we walked back home and talked about the weekend."),
    quiet(2),
  ],
  [
    quiet(1),
    await speech(
      "Tomorrow morning the train leaves at nine, so we should pack tonight and sleep early."
    ),
    quiet(5),
    await speech("Okay, see you later."),
    quiet(4),
  ],
];

const records: Uint8Array[] = [];
let start = T0;
for (const parts of spans) {
  const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => {
    samples.set(p, at);
    return at + p.length;
  }, 0);
  const pcm = join(dir, "span.f32");
  // biome-ignore lint/performance/noAwaitInLoops: one span after the other, through one file
  await Bun.write(pcm, samples);
  const ogg =
    await $`ffmpeg -v error -f f32le -ar ${RATE} -ac 1 -i ${pcm} -c:a libopus -b:a 32k -vbr off -application lowdelay -frame_duration 20 -map_metadata -1 -fflags +bitexact -flags:a +bitexact -f ogg -`.arrayBuffer();
  const packets = oggOpusPackets(new Uint8Array(ogg)) ?? [];
  // Five 20 ms frames a record, about 100 ms; stamped when written, after its frames.
  for (let i = 0; i < packets.length; i += 5) {
    const frames = packets.slice(i, i + 5);
    const record = new Uint8Array(444);
    const end = start + (i + frames.length) * 20;
    new DataView(record.buffer).setUint32(0, Math.floor(end / 1000));
    let at = 4;
    for (const frame of frames) {
      record[at] = frame.length;
      record.set(frame, at + 1);
      at += frame.length + 1;
    }
    records.push(record);
  }
  start += packets.length * 20 + GAP_MS;
}
await rm(dir, { recursive: true });
const bytes = new Uint8Array(records.length * 444);
for (const [i, r] of records.entries()) {
  bytes.set(r, i * 444);
}
await Bun.write(join(out, "omi.bin"), bytes);
console.log(`${records.length} records in ${join(out, "omi.bin")}`);
