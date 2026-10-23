// The owner's switches for paid processing (switches.ts), from the app or `bun run switches`, and
// the words he wants spelled right (vocabulary.ts).
import { createRoute, z } from "@hono/zod-openapi";
import { macEngines } from "@life/voice-db/schema";
import type { Services } from "../services";
import { setSwitches, switches } from "../switches";
import { Keyterm, setVocabulary } from "../vocabulary";
import { json, router } from "./common";

export const SwitchesView = z
  .object({
    ai: z
      .boolean()
      .describe(
        "Summaries and titles on the Mac, and search embeddings. Off: they wait"
      ),
    engine: z
      .enum(macEngines)
      .describe(
        "Which subscription runs AI on the Mac: Claude Max or ChatGPT Codex"
      ),
    openAppAfterMinutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .describe(
        "Minutes the Pendant's audio may wait on the phone, while it records, before a notification " +
          "asks the owner to open the app. 0: never"
      ),
    transcription: z
      .boolean()
      .describe(
        "Audio to ElevenLabs and voices to speaker recognition. Off: uploads wait unsent"
      ),
  })
  .openapi("Switches");

const Vocabulary = z
  .object({
    terms: z
      .array(Keyterm)
      .max(100)
      .describe(
        "The owner's words, sent as keyterms before people's names and aliases"
      ),
  })
  .openapi("Vocabulary");

export function switchRoutes({
  db,
  nudge,
  rolling,
  search,
  worker,
}: Pick<Services, "db" | "nudge" | "rolling" | "search" | "worker">) {
  return router()
    .openapi(
      createRoute({
        method: "get",
        path: "/switches",
        responses: { 200: json(SwitchesView, "The switches now") },
      }),
      (c) => c.json(switches(), 200)
    )
    .openapi(
      createRoute({
        description:
          "Turns transcription or AI on or off, or sets when the app asks to be opened. Turned back on, what waited goes on: the phone " +
          "is nudged to send its waiting audio, summaries due run on the Mac, search catches up.",
        method: "put",
        path: "/switches",
        request: {
          body: {
            content: {
              "application/json": { schema: SwitchesView.partial() },
            },
            required: true,
          },
        },
        responses: { 200: json(SwitchesView, "The switches now") },
      }),
      (c) => {
        const { before, after } = setSwitches(db, c.req.valid("json"));
        if (after.transcription && !before.transcription) {
          nudge("resumed", { switch: "transcription" });
          worker.poke();
        }
        if (after.ai && (!before.ai || after.engine !== before.engine)) {
          rolling.drain();
          search?.index();
        }
        return c.json(after, 200);
      }
    )
    .openapi(
      createRoute({
        description:
          "Replaces the owner's words with this list (idempotent); the feed carries them " +
          "(`vocabulary`). Blocks uploaded from then on are transcribed with them; nothing is " +
          "transcribed again.",
        method: "put",
        path: "/vocabulary",
        request: {
          body: {
            content: { "application/json": { schema: Vocabulary } },
            required: true,
          },
        },
        responses: { 200: json(Vocabulary, "The owner's words now") },
      }),
      (c) =>
        c.json({ terms: setVocabulary(db, c.req.valid("json").terms) }, 200)
    );
}
