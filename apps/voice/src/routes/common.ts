// What every route file shares: the error shape, the 400 for invalid input, small helpers.
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";

const errorCodes = [
  "audio_hash_mismatch",
  "audio_store_unavailable",
  "held",
  "identity_busy",
  "identity_unavailable",
  "intelligence_unavailable",
  "internal_error",
  "invalid_audio",
  "invalid_request",
  "invalid_state",
  "not_found",
  "page_conflict",
  "payload_too_large",
  "search_unavailable",
  "transcription_failed",
  "transcription_off",
] as const;
export const ApiError = z
  .object({ error: z.enum(errorCodes), message: z.string() })
  .openapi("Error");

// Each domain's routes, answering invalid input in the routes' error shape.
export const router = () =>
  new OpenAPIHono({
    defaultHook: (result, c) =>
      result.success
        ? undefined
        : c.json(
            {
              error: "invalid_request" as const,
              message: result.error.message,
            },
            400
          ),
  });

export const IdParam = z.object({ id: z.uuid() });
// A page batch's first index, in the path. Coerced, it would document as optional and nullable, which no client
// generator accepts for a path parameter.
export const FirstPage = z.coerce
  .number()
  .int()
  .min(0)
  .openapi({ minimum: 0, param: { required: true }, type: "integer" });
// A source, in routes and in audio keys (audio-store.ts): never `.` or `..`.
export const SourceId = z
  .string()
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9:._-]{1,128}$/)
  .describe("A Pendant's deviceID, or import:<oldId>");
export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
export const notFound = json(ApiError, "No such job or transcript");
export const Stored = z.object({ stored: z.boolean() });
// transcript.ts `timedWords`: what the phone lights while the words play.
export const TimedWords = z
  .array(z.tuple([z.int(), z.int(), z.int()]))
  .describe(
    "Each word: start and end in ms from the passage's start, and its UTF-16 length in the text with the spacing before it (none before the first)"
  )
  .openapi("TimedWords");

// Refuses a body past `maxSize` bytes before it is read in full.
export const sizeLimit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) =>
      c.json(
        {
          error: "payload_too_large" as const,
          message: `body over ${maxSize} bytes`,
        },
        413
      ),
  });
