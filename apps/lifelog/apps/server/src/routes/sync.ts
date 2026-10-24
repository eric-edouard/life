// Sync: the feed, the phone's playback quiet ranges and the Mac helper's socket.
import { createRoute, z } from "@hono/zod-openapi";
import {
  conversationKinds,
  conversationStates,
  editSources,
  jobStates,
  ownerEditKinds,
  waitingReasons,
} from "@lifelog/db/schema";
import { latestSeq } from "../change-log";
import { record } from "../events";
import { feed, SEQ, waitForChange } from "../feed";
import { MAC_PROTOCOL } from "../mac-socket";
import { addQuietRange, quietRangeInput } from "../quiet-ranges";
import type { Services } from "../services";
import { Subscriptions, subscriptions } from "../subscriptions";
import { switches } from "../switches";
import { json, router, TimedWords } from "./common";
import { Person } from "./speakers";
import { SwitchesView } from "./switches";

// Opened by the Mac helper's own token only (app.ts), at `?protocol=` MAC_PROTOCOL. Its events
// travel on it.
export const MAC_SOCKET_PATH = "/quiet-ranges/socket";

const QuietRange = z
  .object({
    endedAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
    startedAt: z.iso.datetime({ offset: true }),
  })
  .openapi("QuietRange");

const QuietRangeInput = quietRangeInput.openapi("QuietRangeInput");

const MacWatchView = z
  .object({
    asleep: z
      .boolean()
      .describe(
        "The Mac was going to sleep: nothing could be dictated to it from then on"
      ),
    heardAt: z.iso
      .datetime()
      .describe("When the server last heard from the Mac"),
    watchedThrough: z.iso
      .datetime()
      .describe(
        "Every dictation before this is already a quiet range: now while the Mac's socket is open and nothing is pending, else the last time it was heard"
      ),
  })
  .openapi("MacWatch");
const MacLlmView = z
  .object({
    able: z
      .boolean()
      .describe("Summaries run on the Mac now; otherwise they wait for it"),
    reason: z
      .enum(["auth", "limit"])
      .nullable()
      .describe(
        "Why the Mac can't, for 10 minutes after it said so. auth: the selected CLI is signed out on the Mac; limit: the selected subscription's usage limit. Null: away, asleep, or able"
      ),
  })
  .openapi("MacLlm");

const Instant = z.iso.datetime();
const Feed = z
  .object({
    chapters: z.array(
      z.object({
        conversationId: z.uuid(),
        endAt: Instant,
        id: z.uuid().describe("Stable: a re-summarized chapter keeps it"),
        startAt: Instant,
        summary: z.string().nullable(),
        title: z.string().nullable(),
      })
    ),
    conversations: z.array(
      z
        .object({
          closed: z
            .boolean()
            .describe(
              "Settled: the source heard on 5 minutes past its end (an imported one always), so grouping adds nothing to it; late audio or an edit can still reopen it"
            ),
          endAt: Instant,
          endEdit: z
            .uuid()
            .nullable()
            .describe("The live split its end comes from: what Undo undoes"),
          id: z.uuid(),
          kind: z.enum(conversationKinds),
          ownerTitle: z.string().nullable(),
          ownerTitleAt: Instant.nullable(),
          place: z
            .string()
            .nullable()
            .describe("Apple's name of its most accurate named fix"),
          retired: z
            .object({ successorId: z.uuid().nullable() })
            .nullable()
            .describe(
              "Out of the live set (merged or undone): drop what was built from it"
            ),
          runId: z
            .uuid()
            .nullable()
            .describe(
              "The summary its title, TLDR and chapters come from: Generate's `after`"
            ),
          splitSuggestions: z
            .array(z.object({ at: Instant, confidence: z.enum(["medium"]) }))
            .describe(
              "Where the latest summary would split it, unsure: the owner splits there or dismisses it"
            ),
          startAt: Instant,
          startEdit: z
            .uuid()
            .nullable()
            .describe(
              "The live split its start comes from (in the gap before it, or at it), else the merge that joined it: what Undo undoes"
            ),
          state: z
            .enum(conversationStates)
            .describe(
              "Where it stands (conversation-state.ts); the phone adds only Not uploaded yet"
            ),
          title: z
            .string()
            .nullable()
            .describe("Generated: the latest summary's"),
          tldr: z.string().nullable(),
          waiting: z
            .object({
              reason: z.enum(waitingReasons),
              since: Instant.nullable(),
            })
            .nullable(),
        })
        .openapi("FeedConversation")
    ),
    cursor: z
      .string()
      .describe("The last seq read: pass it as `since` next time"),
    edits: z.array(
      z.object({
        at: Instant.nullable(),
        editedAt: Instant,
        from: Instant.nullable(),
        id: z.uuid(),
        kind: z.enum(ownerEditKinds),
        source: z.enum(editSources),
        target: z.uuid().nullable(),
        to: Instant.nullable(),
        undoneAt: Instant.nullable(),
      })
    ),
    jobs: z.array(
      z.object({
        durationSeconds: z
          .number()
          .describe("Seconds of speech audio the job holds"),
        endedOnSilence: z
          .boolean()
          .nullable()
          .describe(
            "True: no speech for at least 30 s after its audio, so no turn follows it closely. False: closed at 2 minutes or on a 5 s pause, whatever followed. Null on older jobs"
          ),
        id: z.uuid(),
        pages: z.array(z.tuple([z.int(), z.int()])).nullable(),
        sourceId: z.string().nullable(),
        state: z.enum(jobStates),
      })
    ),
    mac: z.object({
      dictatingSince: z.iso.datetime({ offset: true }).nullable(),
      llm: MacLlmView,
      subscriptions: Subscriptions,
      watch: MacWatchView.nullable(),
    }),
    more: z.boolean().describe("Ask again at once with the new cursor"),
    people: z.array(Person),
    quietRanges: z.array(QuietRange),
    removed: z
      .array(
        z.object({
          firstPage: z
            .int()
            .optional()
            .describe(
              "A withdrawn job or speech fragment's first page: the phone sends its pages again"
            ),
          kind: z.string(),
          ref: z.string(),
          sourceId: z.string().optional(),
        })
      )
      .describe(
        "Rows that no longer exist (a turn moved off its map, a person merged away, a job's last speaker row, unsent audio withdrawn): drop them"
      ),
    switches: SwitchesView,
    turns: z.array(
      z
        .object({
          conversationId: z
            .uuid()
            .nullable()
            .describe(
              "The live conversation its start falls in: the server's placement, the one rule"
            ),
          endAt: Instant,
          jobId: z.uuid(),
          language: z.string(),
          speaker: z.object({
            displayName: z
              .string()
              .describe(
                'What every reader calls it: the person\'s name, else "Speaker N" in its conversation, as the summaries do'
              ),
            isOwner: z.boolean(),
            label: z.string().nullable(),
            personId: z.uuid().nullable(),
            personName: z
              .string()
              .nullable()
              .describe("As emitted; a rename comes in `people`"),
          }),
          startAt: Instant,
          text: z
            .string()
            .describe(
              "Without dictation and media: empty when all of it is hidden"
            ),
          turnIndex: z.int(),
          words: TimedWords,
        })
        .openapi("FeedTurn")
    ),
    vocabulary: z
      .array(z.string())
      .describe("The owner's words, whole on every page"),
  })
  .openapi("Feed");

// The contract's optional parts (docs/voice-source.md); lifelog offers them all.
const CAPABILITIES = ["corrections", "places", "search", "status"] as const;

export function syncRoutes({ db, mac }: Pick<Services, "db" | "mac">) {
  const app = router();
  // The Mac helper's socket (mac-socket.ts), with Bun's own upgrade. A helper speaking another
  // protocol is refused, never misread.
  app.get(MAC_SOCKET_PATH, (c) => {
    const spoken = (c.req.query("protocol") ?? "1").slice(0, 10);
    if (spoken !== String(MAC_PROTOCOL)) {
      record(db, "mac.refused", { protocol: spoken });
      return c.text(
        `This server speaks the Mac helper's protocol ${MAC_PROTOCOL}, not ${spoken}: install the helper built with it.`,
        426
      );
    }
    return mac.upgrade(c.req.raw, c.env)
      ? new Response(null)
      : c.text("Expected a WebSocket upgrade", 426);
  });
  return app
    .openapi(
      createRoute({
        description:
          "What this voice source offers a reader (docs/voice-source.md): the contract's version " +
          "and its optional parts. A reader's token may still not open every one.",
        method: "get",
        path: "/capabilities",
        responses: {
          200: json(
            z
              .object({
                capabilities: z.array(z.enum(CAPABILITIES)),
                contract: z.literal(1),
              })
              .openapi("Capabilities"),
            "Capabilities"
          ),
        },
      }),
      (c) =>
        c.json({ capabilities: [...CAPABILITIES], contract: 1 as const }, 200)
    )
    .openapi(
      createRoute({
        description:
          "The feed (docs/voice-source.md): `since` a decimal seq (none or 0 for everything); up to 500 " +
          "changes after it, each row as it is now. `wait` holds the request up to that many seconds " +
          "while nothing is newer (an empty page with the same cursor at the end).",
        method: "get",
        path: "/changes",
        request: {
          query: z.object({
            since: z.string().regex(SEQ, "not a cursor").optional(),
            wait: z.coerce.number().int().min(0).max(60).optional(),
          }),
        },
        responses: { 200: json(Feed, "Changes") },
      }),
      async (c) => {
        const { since, wait } = c.req.valid("query");
        const asked = Number(since ?? 0);
        // A cursor past the archive (a restore from a snapshot, the cutover) starts over rather
        // than skip every change made since.
        const from = asked > latestSeq(db) ? 0 : asked;
        if (wait) {
          await waitForChange(db, from, wait, c.req.raw.signal);
        }
        const { watch, ...page } = feed(db, from, mac.live());
        return c.json(
          {
            ...page,
            mac: {
              dictatingSince: mac.dictatingSince(),
              llm: mac.llmState(),
              subscriptions: subscriptions(db),
              watch,
            },
            switches: switches(),
          },
          200
        );
      }
    )
    .openapi(
      createRoute({
        description:
          'A stretch to leave out of transcription, from the phone (its device token): `source` "playback" ' +
          "while it plays a recording out loud. (The Mac's dictation ranges come on its socket.) Words " +
          "already bought inside it are hidden. Idempotent by id: a retry returns the range as stored.",
        method: "post",
        path: "/quiet-ranges",
        request: {
          body: {
            content: { "application/json": { schema: QuietRangeInput } },
            required: true,
          },
        },
        responses: { 200: json(QuietRange, "The range, as stored") },
      }),
      (c) => {
        const input = c.req.valid("json");
        const range = addQuietRange(db, input);
        record(db, "quiet_range.stored", {
          id: range.id,
          seconds:
            (Date.parse(range.endedAt) - Date.parse(range.startedAt)) / 1000,
          source: input.source,
        });
        return c.json(range, 200);
      }
    );
}
