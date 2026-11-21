// A short-lived, single-use ElevenLabs token for the phone's instant dictation: the phone opens Scribe's
// realtime socket itself with it; the key stays on the Mac. Minted only while his `dictationHeard` switch
// is `instant`: the Mac gates every stream. Nothing of the token is logged or kept.
import { createRoute, z } from "@hono/zod-openapi";
import { record } from "../events";
import type { Services } from "../services";
import { switches } from "../switches";
import { ApiError, json, router } from "./common";

const LiveWordsToken = z
  .object({ token: z.string().min(1) })
  .openapi("LiveWordsToken");

export const liveWordsRoutes = ({
  config,
  db,
}: Pick<Services, "config" | "db">) =>
  router().openapi(
    createRoute({
      description:
        "A single-use ElevenLabs token for Scribe's realtime socket (`wss://api.elevenlabs.io/v1/speech-to-text/realtime" +
        "?token=…`), valid 15 minutes and spent when the socket opens. The phone streams a field's dictation with it " +
        "while his `dictationHeard` switch is `instant`, and is refused it otherwise (503: it hears on the Mac). The " +
        "ElevenLabs key never leaves the Mac. Never stored or logged.",
      method: "post",
      path: "/live-words/token",
      responses: {
        200: json(LiveWordsToken, "The token"),
        502: json(ApiError, "ElevenLabs refused or did not answer"),
        503: json(
          ApiError,
          "Instant dictation is off: dictation is heard on the Mac"
        ),
      },
    }),
    async (c) => {
      if (switches().dictationHeard !== "instant") {
        return c.json(
          {
            error: "transcription_off" as const,
            message: "instant dictation is off",
          },
          503
        );
      }
      const refused = () => {
        record(db, "live_words.token_failed", {});
        return c.json(
          {
            error: "transcription_failed" as const,
            message: "ElevenLabs gave no live-words token",
          },
          502
        );
      };
      const res = await fetch(
        `${config.ELEVENLABS_BASE_URL}/v1/single-use-token/realtime_scribe`,
        {
          headers: { "xi-api-key": config.ELEVENLABS_API_KEY },
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        }
      ).catch(() => null);
      const body = res?.ok
        ? LiveWordsToken.safeParse(await res.json().catch(() => null))
        : null;
      return body?.success
        ? c.json({ token: body.data.token }, 200, {
            "Cache-Control": "no-store",
          })
        : refused();
    }
  );
