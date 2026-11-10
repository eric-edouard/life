import { z } from "zod";

// The shapes Life reads from lifelog's API, each field as nullable or optional as lifelog's contract says
// (`apps/server/openapi.json` in lifelog; lifelog.test.ts checks it). Fields Life doesn't read (its chapters and
// summaries among them) are left out and ignored.
export const Page = z.object({
  conversations: z.array(
    z.object({
      // Settled (the contract's `closed`): grouping adds nothing more to it; late audio or an edit can reopen it.
      closed: z.boolean().nullish(),
      endAt: z.string(),
      id: z.string(),
      kind: z.string(),
      ownerTitle: z.string().nullable(),
      // A retired conversation has a successor, or none (lifelog dropped it, e.g. playback it transcribed by mistake).
      retired: z.object({ successorId: z.string().nullable() }).nullable(),
      startAt: z.string(),
      state: z.string(),
      title: z.string().nullable(),
    })
  ),
  cursor: z.string(),
  // Each recording, and whether nobody spoke for 30 s after it (`endedOnSilence`; null on older ones).
  jobs: z.array(
    z.object({ endedOnSilence: z.boolean().nullish(), id: z.string() })
  ),
  more: z.boolean(),
  removed: z.array(z.object({ kind: z.string(), ref: z.string() })),
  turns: z
    .array(
      z.object({
        // null while lifelog's server has not yet grouped the turn into a conversation; it is sent again once it has.
        conversationId: z.string().nullable(),
        endAt: z.string(),
        jobId: z.string(),
        // Who spoke, as the server resolves it: a name given to one turn beats the voice's name.
        speaker: z.object({
          inference: z
            .object({
              attemptId: z.string(),
              basis: z.enum(["context", "two-person"]),
              confidence: z.number(),
              evidence: z.array(
                z.object({
                  jobId: z.string(),
                  quote: z.string(),
                  turnIndex: z.number(),
                })
              ),
              inputHash: z.string(),
              snapshotRevision: z.number(),
            })
            .nullish(),
          isOwner: z.boolean().default(false),
          personId: z.string().nullable(),
          personName: z.string().nullable(),
          source: z.enum(["owner", "recognized", "inferred"]).nullish(),
        }),
        startAt: z.string(),
        turnIndex: z.number(),
      })
    )
    .transform((ts) =>
      ts.filter(
        (t): t is typeof t & { conversationId: string } =>
          t.conversationId !== null
      )
    ),
});
export type Page = z.infer<typeof Page>;

/** Context attribution describes a voice; it cannot authorize Life's owner-word actions. */
export const isOwnerSpeech = (speaker: Page["turns"][number]["speaker"]) =>
  speaker.isOwner && speaker.source !== "inferred";
