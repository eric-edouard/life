import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toOggOpus } from "./voice-notes";

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
      const text = new TextDecoder("latin1").decode(ogg);
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
