// A chat voice note heard for Life: its words by the speech service, Thai turns by Scribe, as a
// recording's block is (route-turns.ts). Nothing of the audio is kept; one row per note
// (`voice_note_hearings`) makes its Scribe send happen once.
import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { clock } from "@life/server/src/core/clock";
import { voiceNoteHearings } from "@lifelog/db/schema/voice-note-hearings";
import { eq } from "drizzle-orm";
import { oggOpusSeconds } from "../audio";
import { Sha256 } from "../config";
import { ownerZoneAt } from "../diagnostics";
import { parseTranscript, textOf } from "../elevenlabs";
import { record } from "../events";
import { hearRouted } from "../hear-routed";
import { barOf, routeTurns, transcriptOf } from "../route-turns";
import type { Services } from "../services";
import { transcribeBlock } from "../speech-service";
import { blockKeyterms } from "../vocabulary";
import { ApiError, json, router, sizeLimit } from "./common";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SECONDS = 600;
/** A claim younger than this is a send under way: the same note asked again waits. */
const IN_FLIGHT_MS = 5 * 60 * 1000;

type Said = { text: string } | { invalid: boolean; message: string };
const busy = (message: string): Said => ({ invalid: false, message });
const LATER = { "Retry-After": "300" };
// Life waits 180 s for the words, most of it for the speech service: a Scribe slot now, or busy.
const SLOT_WAIT_MS = 0;

export function voiceNoteRoutes({
  config,
  db,
  worker,
}: Pick<Services, "config" | "db" | "worker">) {
  /** Words as text, from a transcript in Scribe's shape. */
  const textFrom = (raw: unknown) =>
    textOf(parseTranscript(raw).transcript.words).trim();
  /** Settles a claimed note with `text`, and answers it. */
  const settle = (key: string, text: string) => {
    db.update(voiceNoteHearings)
      .set({ doneAt: clock(), text })
      .where(eq(voiceNoteHearings.key, key))
      .run();
    return text;
  };

  /** A note asked before: its words, or busy while its send is under way; none when new. */
  const replayOf = (key: string): Said | undefined => {
    const claimed = db
      .select()
      .from(voiceNoteHearings)
      .where(eq(voiceNoteHearings.key, key))
      .get();
    if (!claimed) {
      return;
    }
    if (claimed.doneAt) {
      return { text: claimed.text ?? "" };
    }
    // A lost answer or a crash mid-send: never sent again, its local words stand.
    return clock().getTime() - claimed.claimedAt.getTime() < IN_FLIGHT_MS
      ? busy("this note is being heard")
      : { text: settle(key, claimed.localText) };
  };

  /** A new note: the speech service, then Scribe for its routed turns, claimed first. */
  async function hearNote(
    bytes: Uint8Array,
    at: string,
    key: string,
    seconds: number
  ): Promise<Said> {
    const said = await transcribeBlock(config, bytes);
    if ("error" in said) {
      return said.error === "invalid_audio"
        ? { invalid: true, message: said.message }
        : busy("the speech service is busy or off");
    }
    const route = routeTurns(said.heard, barOf(ownerZoneAt(db, new Date(at))));
    const routed = route.kind === "whole" ? said.heard.turns : route.routed;
    const localText = textFrom(transcriptOf(said.heard, routed, null));
    if (routed.length === 0) {
      record(db, "voice_note.heard", { route: "local", seconds });
      return { text: localText };
    }
    const heard = await hearRouted({ config, db }, bytes, said.heard, routed, {
      keyterms: blockKeyterms(db),
      ref: { voiceNote: key.slice(0, 12) },
      send: (post) =>
        worker.paidSend(
          `voice-note:${randomUUID()}`,
          { priority: "ordinary", waitMs: SLOT_WAIT_MS },
          () =>
            db
              .insert(voiceNoteHearings)
              .values({ key, localText })
              .onConflictDoNothing()
              .returning()
              .all().length === 1
              ? null
              : "this note is being heard",
          post
        ),
    });
    if (heard.kind === "unsent") {
      return busy(heard.error);
    }
    if (heard.kind === "later") {
      // Nothing was taken or billed: the claim goes, the note may be sent again.
      db.delete(voiceNoteHearings).where(eq(voiceNoteHearings.key, key)).run();
      return busy(heard.error);
    }
    record(db, "voice_note.heard", {
      billableSeconds: heard.billableSeconds,
      route: route.kind,
      seconds,
    });
    return { text: settle(key, textFrom(heard.transcript)) };
  }

  return router().openapi(
    createRoute({
      description:
        "A chat voice note's words (Ogg Opus, at most 10 minutes), heard like a recording's block: " +
        "the speech service, and Scribe for the turns it routes as Thai by where the owner was at " +
        "`at`. `key` is the sha256 of the note's original file: a note sent to Scribe is sent once, " +
        "and asked again its words come back. Nothing of the audio is kept. 503 when the speech " +
        "service or transcription is off or busy, or the note needs Scribe while its credits are out " +
        "or Scribe takes nothing now: send it again later.",
      method: "post",
      middleware: [sizeLimit(MAX_BYTES)] as const,
      path: "/voice-notes/transcript",
      request: {
        body: {
          content: {
            "audio/ogg": {
              schema: z.string().openapi({ format: "binary", type: "string" }),
            },
          },
          required: true,
        },
        query: z.object({ at: z.iso.datetime({ offset: true }), key: Sha256 }),
      },
      responses: {
        200: json(
          z.object({ text: z.string() }).openapi("VoiceNoteWords"),
          "Its words; empty when nothing was heard"
        ),
        400: json(ApiError, "Not Ogg Opus, or longer than 10 minutes"),
        413: json(ApiError, "Over 16 MB"),
        503: json(ApiError, "Not now: send it again later"),
      },
    }),
    async (c) => {
      const { at, key } = c.req.valid("query");
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const seconds = oggOpusSeconds(bytes);
      if (seconds === null || seconds > MAX_SECONDS) {
        return c.json(
          {
            error: "invalid_audio" as const,
            message: "audio must be Ogg Opus of at most 10 minutes",
          },
          400
        );
      }
      const said = replayOf(key) ?? (await hearNote(bytes, at, key, seconds));
      if ("text" in said) {
        return c.json({ text: said.text }, 200);
      }
      return said.invalid
        ? c.json(
            { error: "invalid_audio" as const, message: said.message },
            400
          )
        : c.json(
            { error: "identity_busy" as const, message: said.message },
            503,
            LATER
          );
    }
  );
}
