// A short-lived, single-use ElevenLabs token for the phone's live words while he holds Tell Life: the phone
// opens Scribe's realtime socket itself with it; the key stays on the Mac. Nothing of the token is logged or kept.
import { createRoute, z } from "@hono/zod-openapi";
import { record } from "../events";
import type { Services } from "../services";
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
        "?token=…`), valid 15 minutes and spent when the socket opens. The phone streams his live words with it " +
        "while he holds Tell Life; the ElevenLabs key never leaves the Mac. Never stored or logged.",
      method: "post",
      path: "/live-words/token",
      responses: {
        200: json(LiveWordsToken, "The token"),
        502: json(ApiError, "ElevenLabs refused or did not answer"),
      },
    }),
    async (c) => {
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
