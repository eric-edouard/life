import { expect, test } from "bun:test";
import { label, packetsIn } from "./page-audio";
import {
  type Fragment,
  type Interval,
  keptAudio,
  nextFragment,
  omiRecord,
  type PlacedRun,
  pagesOf,
  pieces,
  placeOmi,
  runEnd,
  sileroSpeech,
  subtracting,
  unheld,
  unioned,
} from "./page-rules";

// fixtures/pages: made-up Omi records (scripts/page-fixture.ts) and what Kit's own code makes of
// them (PageProcessingParityTests, `WRITE_PAGES=1`).
const dir = new URL("../../../fixtures/pages/", import.meta.url);
const bin = new Uint8Array(
  await Bun.file(new URL("omi.bin", dir)).arrayBuffer()
);
const expected = await Bun.file(new URL("expected.json", dir)).json();
const records = Array.from({ length: bin.length / 444 }, (_, i) => {
  const record = omiRecord(bin.subarray(i * 444, (i + 1) * 444));
  if (!record) {
    throw new Error(`record ${i}`);
  }
  return record;
});
const spans = placeOmi(
  records.map((r, index) => ({
    index,
    packets: r.frames.length,
    stampMs: r.stampMs,
  }))
);

test("parity: Silero in the worker labels each piece as Kit's Core ML model does", async () => {
  const runs = spans.flatMap((s) => s.runs);
  const labeled = await Promise.all(
    spans
      .flatMap((s) => pieces(s))
      .map(async (p) => {
        const reach: Interval = [p.start - 219, p.end + 20];
        const probabilities = await label({
          continues: false,
          end: p.end,
          final: true,
          packets: [
            ...packetsIn(runs, (page) => records[page]?.frames ?? [], reach),
          ],
          start: p.start,
          stream: `parity#${p.first}`,
        });
        return {
          p,
          probabilities: probabilities?.probabilities ?? new Float32Array(),
        };
      })
  );
  expect(labeled.length).toBe(expected.pieces.length);
  for (const [i, { p, probabilities }] of labeled.entries()) {
    const kit = expected.pieces[i];
    expect([p.first, p.last, p.start, p.end]).toEqual([
      kit.first,
      kit.last,
      kit.start,
      kit.end,
    ]);
    expect(probabilities.length).toBe(kit.probabilities.length);
    const worst = Math.max(
      ...kit.probabilities.map((k: number, f: number) =>
        Math.abs(k - (probabilities[f] ?? 0))
      )
    );
    expect(worst).toBeLessThan(0.05);
    expect(sileroSpeech(probabilities, p.start, p.end - p.start)).toEqual(
      kit.speech
    );
  }
});

test("parity: kept audio and fragments are Kit's, exactly", () => {
  const speech = unioned(
    expected.pieces.flatMap((p: { speech: Interval[] }) => p.speech)
  );
  const audio = spans.map(
    (s): Interval => [s.runs[0]?.start ?? 0, runEnd(s.runs.at(-1) as PlacedRun)]
  );
  const analyzed = expected.pieces.map(
    (p: { start: number; end: number }): Interval => [p.start, p.end]
  );
  const kept = keptAudio(audio, speech, analyzed, expected.quiet);
  expect(kept).toEqual(expected.kept);
  const runs = spans.flatMap((s) => s.runs);
  const fragments: Fragment[] = [];
  let cursor = 0;
  for (;;) {
    const free = unheld(kept, runs, (page) => page < cursor);
    const fragment = nextFragment(
      free.kept,
      free.runs,
      speech,
      expected.heardThrough
    );
    if (!fragment) {
      break;
    }
    fragments.push(fragment);
    cursor = fragment.last + 1;
  }
  expect(fragments).toEqual(expected.fragments);
});

test("intervals: joined when they touch, subtracted piece by piece", () => {
  expect(
    unioned([
      [5, 8],
      [0, 2],
      [2, 3],
      [7, 9],
      [4, 4],
    ])
  ).toEqual([
    [0, 3],
    [5, 9],
  ]);
  expect(
    subtracting(
      [
        [0, 10],
        [20, 30],
      ],
      [
        [2, 3],
        [8, 22],
        [25, 26],
      ]
    )
  ).toEqual([
    [0, 2],
    [3, 8],
    [22, 25],
    [26, 30],
  ]);
});

test("an Omi record: padding skipped, a frame running to the last byte dropped, uptime untimed", () => {
  const record = new Uint8Array(444);
  new DataView(record.buffer).setUint32(0, 1_767_348_000);
  record.set([2, 9, 9, 0, 0, 3, 7, 7, 7], 4);
  expect(omiRecord(record)).toEqual({
    frames: [new Uint8Array([9, 9]), new Uint8Array([7, 7, 7])],
    stampMs: 1_767_348_000_000,
  });
  record[440] = 3; // its frame would end on the last byte
  expect(omiRecord(record)?.frames.length).toBe(2);
  new DataView(record.buffer).setUint32(0, 0x80_00_00_05);
  expect(omiRecord(record)?.stampMs).toBeNull();
  expect(omiRecord(record.subarray(1))).toBeNull();
});

test("placing records: back to back within a step, a short silence kept, a jump or a hole breaks", () => {
  const t = 1_767_348_000_000;
  const page = (index: number, stampMs: number | null, packets = 5) => ({
    index,
    packets,
    stampMs,
  });
  const placed = placeOmi([
    page(0, t),
    page(1, t), // same second: right after
    page(2, t + 1000), // 800 ms later by its stamp, within the step: back to back
    page(3, t + 1800), // 1.5 s after the audio's end: a short silence where the stamp says
    page(4, t + 9000), // a jump: a new span
    page(6, t + 9000), // a hole before it
    page(7, null), // untimed
    page(8, t + 9500),
  ]);
  expect(placed.map((s) => s.breaks)).toEqual([
    [],
    ["timeGap"],
    ["missingPages"],
    ["untimedPage"],
  ]);
  expect(placed[0]?.runs.map((r) => r.start)).toEqual([
    t,
    t + 100,
    t + 200,
    t + 1800,
  ]);
  // Continuing from what was placed before.
  expect(placeOmi([page(9, t + 600)], { end: t + 500, page: 8 })).toEqual([
    { breaks: [], runs: [{ packets: 5, page: 9, start: t + 500 }] },
  ]);
});

test("pieces: at most about 10 minutes, a silence before a cut in the earlier piece", () => {
  const runs = Array.from({ length: 13 }, (_, i) => ({
    packets: 3000, // a minute
    page: i,
    start: i * 61_000,
  }));
  const cut = pieces({ breaks: [], runs });
  expect(cut.map((p) => [p.first, p.last, p.start, p.end])).toEqual([
    [0, 8, 0, 9 * 61_000],
    [9, 12, 9 * 61_000, 12 * 61_000 + 60_000],
  ]);
});

test("Silero windows: 8 frames at 0.3 in a second make it speech", () => {
  const p = new Float32Array(63).fill(0.1);
  p.fill(0.3, 0, 8); // first second: 8 frames
  p.fill(0.9, 32, 39); // second second: 7 frames
  expect(sileroSpeech(p, 1000, 2010)).toEqual([[1000, 2000]]);
});

test("kept audio: speech padded 1 s, gaps under 3 s bridged, unanalyzed counted, quiet cut", () => {
  expect(
    keptAudio(
      [[0, 60_000]],
      [
        [10_000, 12_000],
        [14_500, 15_000],
        [30_000, 31_000],
      ],
      [[0, 50_000]],
      [[30_500, 31_200]]
    )
  ).toEqual([
    [9000, 16_000],
    [29_000, 30_500],
    [31_200, 32_000],
    [50_000, 60_000],
  ]);
});

const run = (page: number, start: number, packets = 50): PlacedRun => ({
  packets,
  page,
  start,
});
// One page a second.
const pagesFrom = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => run(from + i, (from + i) * 1000));

test("a fragment ends at the last pause: kept audio after it, or heard-through past it", () => {
  const runs = pagesFrom(0, 30);
  const kept: Interval[] = [
    [2000, 6000],
    [12_000, 15_000],
  ];
  expect(nextFragment(kept, runs, [], null)).toEqual({
    last: 11,
    pages: [[2, 5]],
    segments: [[2000, 6000]],
  });
  // Nothing after the second stretch: it waits until heard-through passes it.
  const later = unheld(kept, runs, (p) => p <= 11);
  expect(nextFragment(later.kept, later.runs, [], 14_000)).toBeNull();
  expect(nextFragment(later.kept, later.runs, [], 15_000)?.last).toBe(14);
});

test("with no pause, a minute waiting is cut in a non-speech second; otherwise at 90 s", () => {
  const runs = pagesFrom(0, 120);
  const kept: Interval[] = [[0, 120_000]];
  const speech: Interval[] = [
    [0, 40_000],
    [41_500, 120_000],
  ];
  expect(nextFragment(kept, runs, speech, null)?.last).toBe(40);
  expect(nextFragment(kept, runs, [[0, 120_000]], null)?.last).toBe(89);
  // Under a minute waiting, no pause: it waits.
  expect(
    nextFragment([[0, 50_000]], pagesFrom(0, 50), speech, null)
  ).toBeNull();
});

test("held pages and their audio are left out; stretches under half a second go", () => {
  const runs = pagesFrom(0, 10);
  const free = unheld(
    [
      [600, 3300],
      [6000, 6400],
    ],
    runs,
    (p) => p === 1 || p === 2
  );
  expect(free.kept).toEqual([]);
  expect(free.runs.map((r) => r.page)).toEqual([0, 3, 4, 5, 6, 7, 8, 9]);
  expect(unheld([[0, 4000]], runs, (p) => p === 1).kept).toEqual([
    [0, 1000],
    [2000, 4000],
  ]);
  expect(pagesOf([[1500, 3200]], runs)).toEqual([[1, 3]]);
});
