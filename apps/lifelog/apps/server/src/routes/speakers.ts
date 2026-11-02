// Speakers: a job's audio, the owner's answers, and the people they name. Voice samples are cut on
// the server (excerpts.ts).
import { createRoute, z } from "@hono/zod-openapi";
import { people, speakerStatuses, suggestionKinds } from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { byteRange } from "../audio-store";
import { logChange } from "../change-log";
import { answerVoices } from "../naming-queue";
import { aliasesOf, assign, merge, personRow } from "../people";
import type { Services } from "../services";
import {
  ApiError,
  IdParam,
  json,
  notFound,
  router,
  TimedWords,
} from "./common";

const JobParam = z.object({ jobId: z.uuid() });

// Who a speaker (turnIndex null) or one turn is. A turn without its own row is its speaker's.
const SpeakerAssignment = z
  .object({
    jobId: z.uuid(),
    personId: z.uuid().nullable(),
    personName: z.string().nullable(),
    speakerLabel: z.string(),
    status: z.enum(speakerStatuses),
    turnIndex: z.int().nullable(),
  })
  .openapi("SpeakerAssignment");

export const Person = z
  .object({
    // Other names the owner uses for them ("Mamie", "Jojo"), for the AI and the assistant.
    aliases: z.array(z.string()),
    id: z.uuid(),
    // The owner himself.
    isOwner: z.boolean(),
    name: z.string(),
  })
  .openapi("Person");

const SpeakerTarget = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("person"), personId: z.uuid() }),
    z.object({
      // The new person's id, chosen by the phone: a replay finds the person made the first time.
      id: z.uuid(),
      kind: z.literal("new"),
      name: z.string().trim().min(1).max(200),
    }),
    z.object({ kind: z.literal("unknown") }),
    // A video, TV or radio: hidden from summaries and search, never a voice profile.
    z.object({ kind: z.literal("media") }),
  ])
  .openapi("SpeakerTarget");

const Voice = z.object({
  conversationId: z.uuid(),
  jobId: z.uuid(),
  speakerLabel: z.string(),
});

const QueueItem = z
  .object({
    // Its clean turns of its voice, best first (naming-queue.ts `cardClips`). Cards with one to play
    // come first.
    clips: z.array(
      z.object({
        at: z.iso.datetime().nullable(),
        // Seconds of the job's bucket audio (`GET /transcripts/{jobId}/audio`); null for a job
        // from before the bucket, which the phone plays from `at` to `until` in its recording.
        audio: z
          .object({ end: z.number(), jobId: z.uuid(), start: z.number() })
          .nullable(),
        conversationId: z.uuid(),
        // The turn, for "several people" to name it in place, and who it reads as now.
        jobId: z.uuid(),
        personId: z.uuid().nullable(),
        speakerLabel: z.string().nullable(),
        // The words said before it is cut.
        text: z.string(),
        turnIndex: z.int(),
        until: z.iso.datetime().nullable(),
        words: TimedWords,
      })
    ),
    conversations: z.int(),
    // Turns where the summaries heard its name.
    evidence: z.array(
      z.object({
        at: z.iso.datetime().nullable(),
        conversationId: z.uuid(),
        text: z.string(),
      })
    ),
    exchanges: z.int(),
    // Its voice group (the unnamed group recognition keeps), or its one voice's `jobId/label`.
    id: z.string(),
    kind: z.enum(suggestionKinds),
    // The name the summaries heard; null when none, or when it is already the known person's
    // name or alias.
    name: z.string().nullable(),
    // Who it sounds like, for a known person.
    personId: z.uuid().nullable(),
    seconds: z.number(),
    voices: z.array(Voice),
  })
  .openapi("QueueItem");

const noPerson = { error: "not_found" as const, message: "no such person" };

export function speakerRoutes({
  audio,
  db,
  queue,
  voices,
}: Pick<Services, "audio" | "db" | "queue" | "voices">) {
  return router()
    .openapi(
      createRoute({
        description:
          "The Ogg Opus audio of a job, as kept in the bucket: the file a queue clip's `audio` " +
          "points into (seconds from its start). Honors one `Range: bytes=` header. 404 for a job " +
          "from before the bucket.",
        method: "get",
        path: "/transcripts/{jobId}/audio",
        request: { params: JobParam },
        responses: {
          200: {
            content: {
              "audio/ogg": {
                schema: z.any().openapi({ format: "binary", type: "string" }),
              },
            },
            description: "The audio, or the range asked for (206)",
          },
          404: notFound,
          502: json(ApiError, "The bucket is unreachable"),
        },
      }),
      async (c) => {
        const { jobId } = c.req.valid("param");
        const job = db.query.transcriptionJobs
          .findFirst({
            columns: { objectKey: true },
            where: (j, { eq: is }) => is(j.id, jobId),
          })
          .sync();
        const bytes = job?.objectKey
          ? await audio.get(job.objectKey).catch(() => undefined)
          : null;
        if (bytes === undefined) {
          return c.json(
            {
              error: "audio_store_unavailable" as const,
              message: "the bucket is unreachable",
            },
            502
          );
        }
        if (!bytes) {
          return c.json(
            { error: "not_found" as const, message: "no audio for this job" },
            404
          );
        }
        const headers = {
          "Accept-Ranges": "bytes",
          "Content-Type": "audio/ogg",
        };
        const range = byteRange(c.req.header("Range"), bytes.length);
        return range
          ? c.body(bytes.slice(range.start, range.end + 1), 206, {
              ...headers,
              "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}`,
            })
          : c.body(bytes.slice(), 200, headers);
      }
    )
    .openapi(
      createRoute({
        description:
          "The owner names (kind new), assigns (kind person) or un-assigns (kind unknown) " +
          "a speaker, or one turn when turnIndex is set. Evidence from that scope in this " +
          "transcript moves with it. Survives every later recognition run. A new person takes the " +
          "id the phone chose, so a replay makes nobody twice.",
        method: "put",
        path: "/transcripts/{jobId}/speakers/{speakerLabel}",
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  target: SpeakerTarget,
                  turnIndex: z.int().min(0).optional(),
                }),
              },
            },
            required: true,
          },
          params: JobParam.extend({ speakerLabel: z.string().min(1).max(64) }),
        },
        responses: {
          200: json(z.array(SpeakerAssignment), "Assignments after the change"),
          404: notFound,
        },
      }),
      (c) => {
        const { jobId, speakerLabel } = c.req.valid("param");
        const { target, turnIndex } = c.req.valid("json");
        const result = assign(db, {
          jobId,
          speakerLabel,
          target,
          turnIndex: turnIndex ?? null,
        });
        // What the owner just taught reaches every other conversation.
        voices.soon();
        return Array.isArray(result)
          ? c.json(result, 200)
          : c.json(result, 404);
      }
    )
    .openapi(
      createRoute({
        description:
          "Rename a person or set the other names they go by (the whole list). Evidence " +
          "and assignments are untouched.",
        method: "patch",
        path: "/people/{id}",
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  aliases: z
                    .array(z.string().trim().min(1).max(80))
                    .max(20)
                    .optional(),
                  name: z.string().trim().min(1).max(200).optional(),
                }),
              },
            },
            required: true,
          },
          params: IdParam,
        },
        responses: { 200: json(Person, "The renamed person"), 404: notFound },
      }),
      (c) => {
        const { id } = c.req.valid("param");
        const { aliases, name } = c.req.valid("json");
        const old = db.select().from(people).where(eq(people.id, id)).get();
        if (!old) {
          return c.json(noPerson, 404);
        }
        const newName = name ?? old.name;
        const person = db.transaction((tx) => {
          const renamed = tx
            .update(people)
            .set({
              aliases: aliasesOf(newName, aliases ?? old.aliases),
              name: newName,
            })
            .where(eq(people.id, id))
            .returning()
            .get();
          logChange(tx, "person", id);
          return renamed;
        });
        return person ? c.json(personRow(person), 200) : c.json(noPerson, 404);
      }
    )
    .openapi(
      createRoute({
        description:
          "Merge personId into {id}: its evidence and assignments move over, then it is deleted; " +
          "its names become aliases. " +
          "A replay, once personId is gone, answers {id} as it is.",
        method: "post",
        path: "/people/{id}/merge",
        request: {
          body: {
            content: {
              "application/json": { schema: z.object({ personId: z.uuid() }) },
            },
            required: true,
          },
          params: IdParam,
        },
        responses: { 200: json(Person, "The merged person"), 404: notFound },
      }),
      (c) => {
        const person = merge(
          db,
          c.req.valid("param").id,
          c.req.valid("json").personId
        );
        voices.soon();
        return person
          ? c.json(person, 200)
          : c.json(
              { error: "not_found" as const, message: "no such two people" },
              404
            );
      }
    )
    .openapi(
      createRoute({
        description:
          "The voices to name: unnamed voices of the last 30 days that talked with the owner " +
          "(at least 10 turns traded and a minute of talk), one item per voice across " +
          "conversations and days, the most back-and-forth first, each with clean clips of its " +
          "voice and the name the summaries heard or who it sounds like.",
        method: "get",
        path: "/naming-queue",
        responses: { 200: json(z.array(QueueItem), "Voices to name") },
      }),
      (c) => c.json(queue.items(), 200)
    )
    .openapi(
      createRoute({
        description:
          "The owner's answer for a queue item's voices: a new person (name), a person " +
          "(personId), nobody they know (ignore), a video or TV playing (media), or several people " +
          "(several: who; each turn is decided among them), then the rest of their turns as they read " +
          "(rest). Each voice becomes the owner's correction of " +
          "that speaker, so voice evidence moves with it; answered voices leave the queue.",
        method: "post",
        path: "/naming-queue/answer",
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  answer: z.discriminatedUnion("kind", [
                    z.object({
                      kind: z.literal("confirm"),
                      name: z.string().trim().min(1).max(200),
                    }),
                    z.object({ kind: z.literal("assign"), personId: z.uuid() }),
                    z.object({ kind: z.literal("ignore") }),
                    // A video, TV or radio playing.
                    z.object({ kind: z.literal("media") }),
                    // Several people: who, named passage by passage, someone unknown too.
                    z.object({
                      kind: z.literal("several"),
                      people: z.array(z.uuid()).max(50).default([]),
                      unknown: z.boolean().default(false),
                    }),
                  ]),
                  // Every voice of the item, however many: GET /naming-queue caps none.
                  voices: z
                    .array(Voice.pick({ jobId: true, speakerLabel: true }))
                    .min(1),
                }),
              },
            },
            required: true,
          },
        },
        responses: {
          200: json(
            z.object({ personId: z.uuid().nullable() }),
            "The person the voices went to"
          ),
          404: notFound,
        },
      }),
      (c) => {
        const { answer, voices: answered } = c.req.valid("json");
        const result = answerVoices(db, answered, answer);
        queue.invalidate();
        voices.soon();
        return result
          ? c.json(result, 200)
          : c.json(
              { error: "not_found" as const, message: "no such speaker" },
              404
            );
      }
    );
}
