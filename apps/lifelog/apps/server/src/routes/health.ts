// Health: liveness, the phone's heartbeats, diagnostics and push token, the event trail, and
// the status the owner's sessions read.
import { createRoute, z } from "@hono/zod-openapi";
import { diagnosticKinds } from "@lifelog/db/schema";
import { storePushToken } from "../apns";
import {
  Diagnostic,
  DiagnosticUpload,
  Heartbeat,
  HeartbeatUpload,
  listDiagnostics,
  MAX_DIAGNOSTIC_BYTES,
  MAX_HEARTBEAT_BYTES,
  storeDiagnostic,
  storeHeartbeat,
} from "../diagnostics";
import {
  AppEvent,
  Event,
  listEvents,
  record,
  storeAppEvent,
  tokenPrefix,
} from "../events";
import type { Services } from "../services";
import {
  BackupStatus,
  IdentityStatus,
  liveStatus,
  PendantStatus,
  Pipeline,
  status,
} from "../status";
import { ApiError, json, router, Stored, sizeLimit } from "./common";

const MAX_EVENT_BYTES = 8 * 1024;
const PUSH_TOKEN = /^[0-9a-f]{16,512}$/;
const LiveStatus = z
  .object({
    backup: BackupStatus,
    identity: IdentityStatus,
    mac: z.unknown().describe("The Mac helper, live or as it last left"),
    pendant: PendantStatus.nullable().describe(
      "The Pendant as the phone last saw it; null before any heartbeat"
    ),
    phoneHeartbeat: Heartbeat.nullable().describe(
      "The phone's last heartbeat; null before any"
    ),
    pipeline: Pipeline,
    switches: z.unknown().describe("The owner's switches"),
    transcription: z.object({
      quota: z.unknown().describe("ElevenLabs' credits as last read"),
    }),
  })
  .openapi("LiveStatus");
const Status = LiveStatus.extend({
  archive: z.unknown().describe("The archive's invariants, each count 0"),
  intelligence: z
    .unknown()
    .describe("Seconds from a chapter's end to its summary"),
  lastStepsLast24h: z.unknown().describe("Each chain step's latest event"),
  problemsLast24h: z.unknown().describe("Crashes and errors, by kind"),
  transcription: z.unknown().describe("ElevenLabs' credits and latency"),
}).openapi("Status");

export function healthRoutes(
  s: Pick<Services, "db" | "excerpts" | "mac" | "restic" | "rolling" | "worker">
) {
  const { db } = s;
  return router()
    .openapi(
      createRoute({
        method: "get",
        path: "/health",
        responses: { 200: json(z.object({ ok: z.boolean() }), "Alive") },
        security: [],
      }),
      (c) => c.json({ ok: true }, 200)
    )
    .openapi(
      createRoute({
        description:
          "The phone's capture health: at most every 6 h while the app runs, at once on each " +
          "change of the Pendant's connection or recording, and on notable events. " +
          "Idempotent by id. Kept 90 days.",
        method: "post",
        middleware: [sizeLimit(MAX_HEARTBEAT_BYTES)] as const,
        path: "/health/heartbeat",
        request: {
          body: {
            content: { "application/json": { schema: HeartbeatUpload } },
            required: true,
          },
        },
        responses: {
          200: json(Stored, "Stored, or already stored"),
          413: json(ApiError, "Body too large"),
        },
      }),
      (c) => c.json({ stored: storeHeartbeat(db, c.req.valid("json")) }, 200)
    )
    .openapi(
      createRoute({
        description:
          "The app's push token (hex), for silent pushes and alerts such as the morning's " +
          "voices to name. Sent by the app's sync runs until this server has it; replaces the one before.",
        method: "put",
        path: "/notifications/push-token",
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({ token: z.string().regex(PUSH_TOKEN) }),
              },
            },
            required: true,
          },
        },
        responses: { 200: json(Stored, "Stored") },
      }),
      (c) => {
        const { token } = c.req.valid("json");
        storePushToken(db, token);
        record(db, "apns.token_stored", {
          kind: "alert",
          token: tokenPrefix(token),
        });
        return c.json({ stored: true }, 200);
      }
    )
    .openapi(
      createRoute({
        description:
          "How capture and processing are doing, for the owner's own sessions: the archive's " +
          "invariants, the Pendant and phone as last reported, the Mac helper, the backups, " +
          "ElevenLabs' credits and latency, where audio and summaries are (`pipeline`), and the " +
          "last day's problems and chain steps. It scans the last day: call it on demand, poll " +
          "`/status/live`. Spending is not here.",
        method: "get",
        path: "/status",
        responses: { 200: json(Status, "Status") },
      }),
      (c) => c.json(status(db, s), 200)
    )
    .openapi(
      createRoute({
        description:
          "The cheap part of `/status`, for the Mac host's menu, polled every 30 s: the pipeline, " +
          "the backups, speaker recognition, the Mac, the Pendant and phone as last reported, ElevenLabs' credits and " +
          "the switches. The device token only.",
        method: "get",
        path: "/status/live",
        responses: { 200: json(LiveStatus, "Live status") },
      }),
      (c) => c.json(liveStatus(db, s), 200)
    )
    .openapi(
      createRoute({
        description:
          "One MetricKit diagnostic (crash, hang, CPU or disk-write exception) or a day of " +
          "metrics. Idempotent by id. Kept 90 days.",
        method: "post",
        middleware: [sizeLimit(MAX_DIAGNOSTIC_BYTES)] as const,
        path: "/diagnostics",
        request: {
          body: {
            content: { "application/json": { schema: DiagnosticUpload } },
            required: true,
          },
        },
        responses: {
          200: json(Stored, "Stored, or already stored"),
          413: json(ApiError, "Body too large"),
        },
      }),
      (c) => c.json({ stored: storeDiagnostic(db, c.req.valid("json")) }, 200)
    )
    .openapi(
      createRoute({
        description:
          "Diagnostics received since `since`, newest first, or the one with `id`.",
        method: "get",
        path: "/diagnostics",
        request: {
          query: z.object({
            id: z.uuid().optional(),
            kind: z.enum(diagnosticKinds).optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
            since: z.iso.datetime().optional(),
          }),
        },
        responses: { 200: json(z.array(Diagnostic), "Diagnostics") },
      }),
      (c) => c.json(listDiagnostics(db, c.req.valid("query")), 200)
    )
    .openapi(
      createRoute({
        description:
          "One step the phone saw in a chain the owner relies on (a push, " +
          "playback kept quiet, the cutover). Ids, states and counts only. Idempotent " +
          "by id. Kept 14 days with the server's own.",
        method: "post",
        middleware: [sizeLimit(MAX_EVENT_BYTES)] as const,
        path: "/events",
        request: {
          body: {
            content: { "application/json": { schema: AppEvent } },
            required: true,
          },
        },
        responses: {
          200: json(Stored, "Stored, or already stored"),
          413: json(ApiError, "Body too large"),
        },
      }),
      (c) => {
        storeAppEvent(db, c.req.valid("json"));
        return c.json({ stored: true }, 200);
      }
    )
    .openapi(
      createRoute({
        description:
          "The server's and the phone's events since `since`: the latest `limit`, oldest first.",
        method: "get",
        path: "/events",
        request: {
          query: z.object({
            limit: z.coerce.number().int().min(1).max(5000).default(1000),
            since: z.iso.datetime(),
          }),
        },
        responses: { 200: json(z.array(Event), "Events") },
      }),
      (c) => c.json(listEvents(db, c.req.valid("query")), 200)
    );
}
