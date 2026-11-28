import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toOggOpus } from "./chat-voice-notes";

test.skipIf(!(Bun.which("say") && Bun.which("ffmpeg")))(
  "a voice note that is not Ogg Opus (a bridge's M4A) is made Ogg Opus; an Ogg one passes as it is",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-note-"));
    try {
      const aiff = join(dir, "note.aiff");
      await Bun.$`say -o ${aiff} "See you at eight"`.quiet();
      const m4a = join(dir, "note.m4a");
      await Bun.$`ffmpeg -loglevel error -i ${aiff} ${m4a}`.quiet();
      const ogg = await toOggOpus(m4a, "audio/mp4");
      const text = new TextDecoder("latin1").decode(ogg ?? undefined);
      expect(text.startsWith("OggS")).toBe(true);
      expect(text).toContain("OpusHead");
      const again = join(dir, "again.ogg");
      await Bun.write(again, ogg ?? "");
      expect(await toOggOpus(again, "audio/ogg")).toEqual(ogg);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
);

test.skipIf(!Bun.which("ffmpeg"))(
  "a file with no audio (not media, or a video stream only) is null, never asked again",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-note-"));
    try {
      const fake = join(dir, "note.m4a");
      await Bun.write(fake, "not audio at all");
      expect(await toOggOpus(fake, "audio/mp4")).toBeNull();
      const video = join(dir, "video.m4a");
      await Bun.$`ffmpeg -loglevel error -f lavfi -i color=s=32x32:d=1 -c:v mpeg4 -f mp4 ${video}`.quiet();
      expect(await toOggOpus(video, "audio/mp4")).toBeNull();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
);
