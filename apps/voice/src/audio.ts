// biome-ignore-all lint/suspicious/noBitwiseOperators: Ogg's CRC and Opus's TOC byte are bit fields
// Ogg Opus (RFC 7845) without decoding: measures uploaded audio, so the cost guard never trusts a
// client-declared duration, and joins speech fragments into one job's audio by moving packets.
import type { JobMap } from "@life/voice-db/schema";
import { startsOf } from "./transcript";

const OGG_CAPTURE = 0x4f_67_67_53; // "OggS"
const OPUS_HEAD = "OpusHead";
const GRANULES_PER_MS = 48;
const PAGE_HEADER_BYTES = 27;
const PACKETS_PER_PAGE = 50;
// The serial and the tags the phone's own writer uses (`OggOpusWriter`), so a joined file reads like a block.
const SERIAL = 0x6c_69_66_65;
const ascii = (text: string) => [...new TextEncoder().encode(text)];
const TAGS = new Uint8Array([
  ...ascii("OpusTags"),
  ...[7, 0, 0, 0],
  ...ascii("lifelog"),
  ...[0, 0, 0, 0],
]);

// One whole Ogg page at `offset`: its granule position, lacing values and body range, or null.
function readPage(view: DataView, offset: number) {
  const lacingStart = offset + PAGE_HEADER_BYTES;
  if (lacingStart > view.byteLength || view.getUint32(offset) !== OGG_CAPTURE) {
    return null;
  }
  const start = lacingStart + view.getUint8(offset + 26);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const lacing = bytes.subarray(lacingStart, start);
  const end = start + lacing.reduce((sum, size) => sum + size, 0);
  return end > view.byteLength
    ? null
    : { end, granule: view.getBigInt64(offset + 6, true), lacing, start };
}

// An Ogg Opus file's packets after its two headers, its pre-skip and its length in 48 kHz
// samples (the last page's granule position minus the pre-skip). Null unless the bytes are whole
// Ogg pages that open with an OpusHead.
// ponytail: one logical stream assumed and page CRCs unchecked (the audio hash already guards
// transit); chained streams would need per-serial bookkeeping.
function readOggOpus(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: Uint8Array[] = [];
  let open: number[] = [];
  let granule = 0n;
  let offset = 0;
  for (let page = readPage(view, 0); page; page = readPage(view, offset)) {
    let at = page.start;
    for (const size of page.lacing) {
      open.push(...bytes.subarray(at, at + size));
      at += size;
      // A packet ends on a lacing value under 255; it may go on in the next page.
      if (size < 255) {
        packets.push(new Uint8Array(open));
        open = [];
      }
    }
    // -1 marks a page on which no packet ends.
    granule = page.granule >= 0n ? page.granule : granule;
    offset = page.end;
  }
  const [head] = packets;
  if (
    offset !== bytes.length ||
    !head ||
    head.length < 19 ||
    new TextDecoder().decode(head.subarray(0, 8)) !== OPUS_HEAD
  ) {
    return null;
  }
  const preSkip = new DataView(head.buffer).getUint16(10, true);
  return {
    audio: packets.slice(2),
    head,
    preSkip,
    samples: Number(granule) - preSkip,
  };
}

// An Ogg Opus file's audio packets, or null when it isn't one.
export const oggOpusPackets = (bytes: Uint8Array) =>
  readOggOpus(bytes)?.audio ?? null;

// Seconds of an Ogg Opus file, or null when it isn't one or holds no audio.
export function oggOpusSeconds(bytes: Uint8Array): number | null {
  const file = readOggOpus(bytes);
  return file && file.samples > 0 ? file.samples / 48_000 : null;
}

// 48 kHz samples of an Opus frame by its TOC configuration (RFC 6716, 3.1): SILK, hybrid, CELT.
const FRAME_SAMPLES = [
  ...[1, 2, 3].flatMap(() => [480, 960, 1920, 2880]),
  ...[480, 960, 480, 960],
  ...[1, 2, 3, 4].flatMap(() => [120, 240, 480, 960]),
];

// 48 kHz samples one Opus packet decodes to: its frame size times one, two, or (code 3) the count
// in its second byte.
function packetSamples([toc = 0, frames = 0]: Uint8Array) {
  const count = [1, 2, 2, frames & 0x3f][toc & 3] ?? 0;
  return (FRAME_SAMPLES[toc >> 3] ?? 0) * count;
}

// Ogg's CRC-32: polynomial 0x04C11DB7, not reflected, starting at 0.
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 0x80_00_00_00 ? (value << 1) ^ 0x04_c1_1d_b7 : value << 1;
  }
  return value >>> 0;
});

function oggPage(
  packets: Uint8Array[],
  granule: number,
  sequence: number,
  flags: number
) {
  const lacing = packets.flatMap((p) => [
    ...new Array<number>(Math.floor(p.length / 255)).fill(255),
    p.length % 255,
  ]);
  const page = concat([
    new Uint8Array(PAGE_HEADER_BYTES),
    new Uint8Array(lacing),
    ...packets,
  ]);
  const view = new DataView(page.buffer);
  view.setUint32(0, OGG_CAPTURE);
  page[5] = flags;
  view.setBigInt64(6, BigInt(granule), true);
  view.setUint32(14, SERIAL, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  let crc = 0;
  for (const byte of page) {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  }
  view.setUint32(22, crc, true);
  return page;
}

// One Ogg Opus file of speech and the map that places it in capture time.
export interface MappedAudio {
  audio: Uint8Array;
  map: JobMap;
}

// Joins fragments, in order, into one Ogg Opus stream by moving their packets: no decoding, so no
// loss. The first fragment's OpusHead leads; each later fragment's encoder delay (its pre-skip)
// and the previous one's padding stay in the audio, so its stretches start a few ms off the
// uniform separator rule, and the map's `starts` says exactly where each begins. The stream ends
// with the last stretch, its trailing separator trimmed. Null when a fragment isn't Ogg Opus,
// keeps no stretch, or its map runs past its audio.
// ponytail: every fragment is taken to share the first's channels and input rate (the phone renders
// them all alike), and 50 packets fill at most 255 lacing values only below 1,275 bytes a packet
// (24 kbps makes about 60); compare the OpusHeads and cut pages by lacing count if that changes.
export function joinOggOpus(fragments: MappedAudio[]): MappedAudio | null {
  const head = fragments[0] && readOggOpus(fragments[0].audio);
  if (!head) {
    return null;
  }
  const map: Required<JobMap> = {
    segments: [],
    separatorMs: fragments[0]?.map.separatorMs ?? 0,
    starts: [],
  };
  const packets: { at: number; packet: Uint8Array }[] = [];
  let decoded = 0;
  for (const fragment of fragments) {
    const file = readOggOpus(fragment.audio);
    const end = keptEnd(fragment.map);
    if (!file || end === null || end * GRANULES_PER_MS > file.samples) {
      return null;
    }
    const shift = (decoded + file.preSkip - head.preSkip) / GRANULES_PER_MS;
    map.segments.push(...fragment.map.segments);
    map.starts.push(...startsOf(fragment.map).map((s) => s + shift));
    for (const packet of file.audio) {
      packets.push({ at: decoded, packet });
      decoded += packetSamples(packet);
    }
  }
  const end = head.preSkip + (keptEnd(map) ?? 0) * GRANULES_PER_MS;
  // Packets wholly past the end are the trailing separator: left out.
  const kept = packets.filter((p) => p.at < end).map((p) => p.packet);
  return { audio: oggOpusFile(head.head, kept, end), map };
}

// An Ogg Opus file of `packets` after the OpusHead `head`, ending at granule `end` (48 kHz samples,
// pre-skip included), 50 packets a page.
function oggOpusFile(head: Uint8Array, packets: Uint8Array[], end: number) {
  const pages = [oggPage([head], 0, 0, 0x02), oggPage([TAGS], 0, 1, 0)];
  let done = 0;
  for (let at = 0; at < packets.length; at += PACKETS_PER_PAGE) {
    const page = packets.slice(at, at + PACKETS_PER_PAGE);
    done += page.reduce((sum, p) => sum + packetSamples(p), 0);
    const last = at + PACKETS_PER_PAGE >= packets.length;
    pages.push(oggPage(page, last ? end : done, pages.length, last ? 0x04 : 0));
  }
  return concat(pages);
}

// 16 kHz mono Pendant packets as an Ogg Opus file of `ms` milliseconds, as they are: no pre-skip,
// so each packet plays where the timeline put it.
export function pendantOggOpus(packets: Uint8Array[], ms: number) {
  const head = new Uint8Array([
    ...ascii("OpusHead"),
    1,
    1,
    0,
    0,
    ...[0x80, 0x3e, 0, 0],
    0,
    0,
    0,
  ]);
  return oggOpusFile(head, packets, ms * GRANULES_PER_MS);
}

// Where a map's last kept stretch ends in its audio (ms), or null when it keeps none.
function keptEnd(map: JobMap) {
  const last = map.segments.at(-1);
  return last ? (startsOf(map).at(-1) ?? 0) + last[1] - last[0] : null;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  parts.reduce((at, p) => {
    out.set(p, at);
    return at + p.length;
  }, 0);
  return out;
};
