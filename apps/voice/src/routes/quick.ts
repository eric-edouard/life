// The Pendant's button (docs/pendant.md): the phone sends the minutes before a press as Ogg Opus and gets their
// words back at once, for "Quick question to AI". Neither the audio nor the words are kept, only
// what the call cost (`quick_transcriptions`), which counts in the spending. The same
// audio is transcribed again in its block (owner, Oct 15).
import { createRoute, z } from "@hono/zod-openapi";
import { quickTranscriptions } from "@life/voice-db/schema";
import { oggOpusSeconds } from "../audio";
import { billableSeconds } from "../config";
import { textOf, transcribeNow } from "../elevenlabs";
import { record } from "../events";
import type { Services } from "../services";
import { switches } from "../switches";
import { blockKeyterms } from "../vocabulary";
import { ApiError, json, router, sizeLimit } from "./common";

// The longest window a press asks about, with room to spare.
const MAX_SECONDS = 2 * 60;

const QuickTranscript = z
  .object({ text: z.string() })
  .openapi("QuickTranscript");

export function quickRoutes({ config, db }: Pick<Services, "config" | "db">) {
  // What to transcribe, or why not: the switch, the audio.
  const accepted = async (form: { audio: File }) => {
    const refuse = (
      status: 400 | 409,
      error: "invalid_audio" | "transcription_off",
      message: string
    ) => ({
      refused: [status, error, message] as const,
    });
    if (!switches().transcription) {
      return refuse(409, "transcription_off", "transcription is off");
    }
    const bytes = new Uint8Array(await form.audio.arrayBuffer());
    const seconds = oggOpusSeconds(bytes);
    if (seconds === null || seconds > MAX_SECONDS) {
      return refuse(
        400,
        "invalid_audio",
        "audio must be Ogg Opus of at most 2 minutes"
      );
    }
    const keyterms = blockKeyterms(db);
    return {
      billable: billableSeconds(seconds, { keyterms }),
      bytes,
      keyterms,
      seconds,
    };
  };
  return router().openapi(
    createRoute({
      description:
        "Transcribes the audio before a press of the Pendant's button at once, with the blocks' keyterms, and " +
        "answers its words. Nothing of it is stored but what it cost. Refused while transcription is off (409).",
      method: "post",
      middleware: [sizeLimit(8 * 1024 * 1024)] as const,
      path: "/quick-transcriptions",
      request: {
        body: {
          content: {
            "multipart/form-data": {
              schema: z.object({
                audio: z
                  .instanceof(File)
                  .openapi({ format: "binary", type: "string" }),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: json(QuickTranscript, "Its words"),
        400: json(ApiError, "Audio that is not Ogg Opus of at most 2 minutes"),
        409: json(ApiError, "Transcription is off"),
        502: json(ApiError, "ElevenLabs didn't transcribe it"),
      },
    }),
    async (c) => {
      const checked = await accepted(c.req.valid("form"));
      if ("refused" in checked) {
        const [status, error, message] = checked.refused;
        return c.json({ error, message }, status);
      }
      const { billable, bytes, keyterms, seconds } = checked;
      const started = performance.now();
      const result = await transcribeNow(config, new Blob([bytes]), keyterms);
      const ms = Math.round(performance.now() - started);
      if (result.kind === "done" || result.billed) {
        db.insert(quickTranscriptions)
          .values({ billableSeconds: billable, durationSeconds: seconds })
          .run();
      }
      record(db, "quick_transcription", {
        ms,
        seconds,
        status: result.kind,
      });
      if (result.kind === "failed") {
        return c.json(
          {
            error: "transcription_failed" as const,
            message: `ElevenLabs: ${result.error.slice(0, 200)}`,
          },
          502
        );
      }
      return c.json({ text: textOf(result.transcript.words).trim() }, 200);
    }
  );
}
