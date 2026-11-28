import { z } from "zod";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { exec } from "../core/proc";
import { call } from "./voice-server-call";

// A message's voice note, heard by lifelog's speech pipeline (`POST /voice-notes/transcript`): Ogg Opus in, words out.

/** lifelog's answer: its words, empty when nothing was heard. */
export const VoiceNoteWords = z.object({ text: z.string() });
/** What lifelog takes as it is; anything else (iMessage's CAF, a bridge's M4A) is made Ogg Opus by ffmpeg. */
const OGG = new Set(["audio/ogg", "audio/opus"]);
/**
 * ffmpeg's own words, when it opens the files, for an input it can never make audio of: not a media file, or no audio
 * stream in it. A damaged frame met later while decoding is not one.
 */
const NO_AUDIO =
  /Error opening input files: Invalid data found when processing input|Output file does not contain any stream/;

/**
 * The file at `path` as Ogg Opus bytes; `null` when ffmpeg says it holds no audio (never asked again); nothing on any
 * other failure, ffmpeg missing or timed out included (logged, asked again later). macOS's afconvert lists Ogg Opus
 * but cannot write it (20 Nov 2026), hence ffmpeg.
 */
export async function toOggOpus(path: string, mime: string) {
  if (OGG.has(mime)) {
    return Bun.file(path).bytes();
  }
  const out = `${path}.ogg`;
  const made = await exec(
    [
      "ffmpeg",
      "-loglevel",
      "error",
      "-y",
      "-i",
      path,
      "-vn",
      "-ac",
      "1",
    ].concat(["-c:a", "libopus", "-b:a", "32k", "-f", "ogg", out]),
    { timeout: 120_000 }
  );
  if (made.code !== 0) {
    log("file.read", { cmd: "ffmpeg", error: made.stderr.trim().slice(-200) });
    return NO_AUDIO.test(made.stderr) ? null : undefined;
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
    log("file.read", { ...errorOf(error), what: "voice note" });
  }
}
