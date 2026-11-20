import { z } from "zod";
import { log } from "../core/log";
import { exec } from "../core/proc";
import { call } from "./lifelog-call";

// A message's voice note, heard by lifelog's speech pipeline (`POST /voice-notes/transcript`): Ogg Opus in, words out.

/** lifelog's answer: its words, empty when nothing was heard. */
export const VoiceNoteWords = z.object({ text: z.string() });
/** What lifelog takes as it is; anything else (iMessage's CAF, a bridge's M4A) is made Ogg Opus by ffmpeg. */
const OGG = new Set(["audio/ogg", "audio/opus"]);

/**
 * The file at `path` as Ogg Opus bytes, or nothing when ffmpeg failed or is missing (logged). macOS's afconvert lists
 * Ogg Opus but cannot write it (20 Nov 2026), hence ffmpeg.
 */
export async function toOggOpus(path: string, mime: string) {
  if (OGG.has(mime)) {
    return Bun.file(path).bytes();
  }
  const out = `${path}.ogg`;
  const made = await exec(
    ["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-ac", "1"].concat([
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-f",
      "ogg",
      out,
    ]),
    { timeout: 120_000 }
  ).catch((error: unknown) => ({ code: 1, stderr: String(error) }));
  if (made.code !== 0) {
    log("file.read", { cmd: "ffmpeg", error: made.stderr.trim().slice(-200) });
    return;
  }
  return Bun.file(out).bytes();
}

/**
 * A voice note's words, sent at `at` (where he was then routes its Thai turns), `key` its original file's sha256 (a
 * note is paid for once). Not audio lifelog can hear: no words, for good. Busy, down or not set up: nothing (logged),
 * asked again later.
 */
export async function readVoiceNoteWords(
  ogg: Uint8Array,
  { at, key }: { at: string; key: string }
) {
  try {
    return VoiceNoteWords.parse(
      await call(
        `/voice-notes/transcript?${new URLSearchParams({ at, key })}`,
        180,
        ogg,
        "POST",
        "audio/ogg"
      )
    );
  } catch (error) {
    const { status } = error as { status?: number };
    if (status === 400 || status === 413) {
      return { text: "" };
    }
    log("file.read", { error: String(error), what: "voice note" });
  }
}
