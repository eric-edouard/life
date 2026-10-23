import { expect, test } from "bun:test";
import { joinOggOpus, oggOpusSeconds } from "./audio";
import { oggOpus } from "./testing";
import { captureMillis, keptAt } from "./transcript";

test("Ogg Opus duration: last granule minus pre-skip, whole pages only", () => {
  expect(oggOpusSeconds(oggOpus(12.5))).toBe(12.5);
  expect(oggOpusSeconds(oggOpus(12.5, 0))).toBe(12.5);

  // A trailing page on which no packet ends (granule -1) keeps the previous granule.
  const file = oggOpus(3);
  const open = new Uint8Array([...file, ...file.subarray(file.length - 92)]);
  new DataView(open.buffer).setBigInt64(file.length + 6, -1n, true);
  expect(oggOpusSeconds(open)).toBe(3);

  expect(oggOpusSeconds(file.subarray(0, file.length - 1))).toBeNull();
  expect(oggOpusSeconds(file.subarray(0, 47))).toBeNull(); // OpusHead page only
  expect(oggOpusSeconds(new Uint8Array(64))).toBeNull();
});

// fixtures/fragments: three fragments of 1 kHz tone bursts, as the phone will render them (stretches
// 400 ms apart, a trailing separator), made with
//   ffmpeg -f lavfi -i "aevalsrc='0.5*sin(2*PI*1000*t)*between(t,0.3,0.35)…':s=16000:d=3.3" \
//     -ac 1 -c:a libopus -b:a 24k -map_metadata -1 -fflags +bitexact -flags:a +bitexact a.ogg
// Kit's AudioPipelineTests decode joined.ogg and find each tone where `starts` says.
const dir = new URL("../../../fixtures/fragments/", import.meta.url);
const fixture = await Bun.file(new URL("fragments.json", dir)).json();
const read = async (file: string) =>
  new Uint8Array(await Bun.file(new URL(file, dir)).arrayBuffer());
const fragments = await Promise.all(
  fixture.fragments.map(
    async (f: { file: string; segments: [number, number][] }) => ({
      audio: await read(f.file),
      map: { segments: f.segments, separatorMs: fixture.separatorMs },
    })
  )
);

test("joined fragments: exact length, and each stretch starts where its packets put it", async () => {
  const joined = joinOggOpus(fragments);
  if (!joined) {
    throw new Error("not joined");
  }
  // Fragment a holds 3.3 s after a 312-sample pre-skip: 166 packets of 20 ms, so b's audio
  // begins 3320 ms in, not at the uniform rule's 3300; b's 2.4 s take 121 packets, so c's at 5740.
  expect(joined.map).toEqual({
    segments: fixture.fragments.flatMap(
      (f: { segments: unknown[] }) => f.segments
    ),
    separatorMs: 400,
    starts: fixture.joined.starts,
  });
  // The stream ends with c's last stretch: its trailing separator is trimmed.
  expect(oggOpusSeconds(joined.audio)).toBe(fixture.joined.seconds);
  for (const tone of fixture.tones) {
    expect(keptAt(joined.map, tone.capture)?.prepared).toBe(tone.prepared);
    expect(captureMillis(joined.map, tone.prepared / 1000)).toBe(tone.capture);
  }
  if (process.env.WRITE_WIRE) {
    await Bun.write(new URL(fixture.joined.file, dir), joined.audio);
  }
  expect(joined.audio).toEqual(await read(fixture.joined.file));
});

test("a time in a seam moves forward to the next stretch; past the end there is none", () => {
  const joined = joinOggOpus(fragments);
  if (!joined) {
    throw new Error("not joined");
  }
  const [, , b] = joined.map.segments;
  // 3300 ms is where the uniform rule starts b; the joined audio is still in a's padding.
  expect(captureMillis(joined.map, 3.3)).toBe(b?.[0] ?? 0);
  expect(captureMillis(joined.map, 3.33)).toBe((b?.[0] ?? 0) + 10);
  expect(captureMillis(joined.map, 8.34)).toBeNull();
});

test("a fragment that isn't Ogg Opus, keeps nothing, or whose map outruns its audio joins nothing", () => {
  const [a] = fragments;
  expect(joinOggOpus([])).toBeNull();
  expect(
    joinOggOpus([{ audio: new Uint8Array(64), map: a.map }, a])
  ).toBeNull();
  expect(
    joinOggOpus([a, { ...a, map: { segments: [], separatorMs: 400 } }])
  ).toBeNull();
  // a's stretches end at 2.9 s of its 3.3 s; 0.5 s more is past its audio.
  const [first, [from = 0, to = 0] = []] = a.map.segments;
  expect(
    joinOggOpus([
      { ...a, map: { ...a.map, segments: [first, [from, to + 500]] } },
    ])
  ).toBeNull();
});
