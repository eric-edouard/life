// Remote crash, error and health reporting: MetricKit diagnostics and daily metrics from the
// phone, every error the owner saw in the app, the server's own 500s, and small capture-health
// heartbeats. States, counts, call stacks and shortened error messages only: never audio,
// transcripts, names, places, coordinates or request bodies. Kept RETENTION_DAYS after arrival.
import { randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { isTimeZone } from "@life/server/src/core/time-zone";
import type { Db } from "@lifelog/db";
import {
  diagnosticKinds,
  diagnostics,
  heartbeatReasons,
  heartbeats,
} from "@lifelog/db/schema";
import { and, desc, eq, gte, isNotNull, lt, lte, sql } from "drizzle-orm";
import { DEFAULT_TIME_ZONE, setOwnerTimeZone } from "./config";

const RETENTION_DAYS = 90;
// Request bodies past these are refused before parsing. A crash with every thread's stack is
// a few hundred kilobytes; the phone caps the frames it sends.
export const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
export const MAX_HEARTBEAT_BYTES = 16 * 1024;

const Short = z.string().max(200);
const Instant = z.iso.datetime();
// Mach-O UUIDs carry no RFC 9562 version bits, so any 8-4-4-4-12 hex.
const BinaryUuid = z.guid();
const Count = z.int().nonnegative();

const Build = z.object({
  appBuild: Short,
  appVersion: Short,
  device: Short.describe('Model identifier, "iPhone17,1".'),
  os: Short,
});

// One call stack, flattened depth-first in MetricKit's own nesting: a frame at depth d+1 is a
// sub-frame of the closest frame above it at depth d. Address minus offset is the load address.
const Frame = z.object({
  address: Count.optional(),
  binaryName: Short.optional(),
  binaryUUID: BinaryUuid.optional(),
  depth: z.int().min(0).max(4096),
  offsetIntoBinaryTextSegment: Count.optional(),
  sampleCount: Count.optional(),
});
type Frame = z.infer<typeof Frame>;
const CallStack = z.object({
  frames: z.array(Frame).max(8192),
  threadAttributed: z.boolean(),
});
type CallStack = z.infer<typeof CallStack>;

// An error the owner saw in the app (`app_error`) or a 500 the server answered (`server_error`).
const ErrorDetail = z.object({
  code: z.int().optional().describe("The NSError code."),
  count: z
    .int()
    .min(1)
    .default(1)
    .describe("Repeats within the hour, sent again under the same id."),
  domain: Short.optional().describe("The NSError domain."),
  file: Short.optional(),
  httpStatus: z.int().optional().describe("The server's answer, if any."),
  line: Count.optional(),
  message: z.string().max(1000).describe("Shortened."),
  method: Short.optional(),
  route: Short.optional(),
  serverCode: Short.optional().describe("The server's `Error.error`."),
  stack: z.string().max(8000).optional().describe("A server error's frames."),
  type: Short,
});

export const DiagnosticUpload = z
  .object({
    begin: Instant,
    binaries: z
      .array(z.object({ name: Short, uuid: BinaryUuid }))
      .max(1024)
      .describe(
        "Every binary in the call stacks: the app's UUIDs are its dSYMs'."
      ),
    build: Build.describe("The build and OS the diagnostic was recorded on."),
    bytesWritten: z.number().nonnegative().optional(),
    callStacks: z.array(CallStack).max(4096),
    crash: z
      .object({
        exceptionCode: z.number().nonnegative().optional(),
        exceptionType: z.int().optional(),
        objcException: z
          .object({
            className: Short,
            formatString: z.string().max(1000),
            name: Short,
            type: Short,
          })
          .optional()
          .describe("Never the composed message or its arguments."),
        signal: z.int().optional(),
        terminationCategory: Short.optional(),
        terminationReason: z.string().max(1000).optional(),
      })
      .optional(),
    durationSeconds: z
      .number()
      .nonnegative()
      .optional()
      .describe("A hang's duration, or a CPU exception's CPU time."),
    end: Instant,
    error: ErrorDetail.optional(),
    id: z.uuid(),
    kind: z.enum(diagnosticKinds),
    metrics: z
      .record(z.string().regex(/^[a-zA-Z]\w{0,63}$/), z.number())
      .refine((m) => Object.keys(m).length <= 200, "at most 200 metrics")
      .optional()
      .describe(
        "A day of MetricKit metrics, numbers only: seconds, bytes, counts."
      ),
    truncated: z
      .boolean()
      .default(false)
      .describe("The phone dropped frames past its cap."),
  })
  .openapi("DiagnosticUpload");
export type DiagnosticUpload = z.infer<typeof DiagnosticUpload>;

export const Diagnostic = DiagnosticUpload.extend({
  receivedAt: Instant,
  signature: z.string(),
}).openapi("Diagnostic");

// Case names of the app's enums (Capture), without their payloads.
const connectionStates = [
  "idle",
  "bluetooth_off",
  "unauthorized",
  "unsupported",
  "scanning",
  "connecting",
  "discovering",
  "pairing_pending",
  "ready",
  "busy_elsewhere",
  "disconnected",
] as const;
const recordingStates = [
  "unknown",
  "recording",
  "paused",
  "pause_requested",
  "resume_requested",
  "failed",
] as const;
const syncPhases = [
  "idle",
  "requesting_status",
  "downloading",
  "persisting",
  "acking",
  "gap_recorded",
  "caught_up",
  "failed",
] as const;
const incidentKinds = [
  "integrity_conflict",
  "encrypted_audio",
  "undecodable_page",
  "storage_write_failed",
  "recording_stopped_unexpectedly",
  "recording_control_failed",
] as const;

export const HeartbeatUpload = z
  .object({
    backlog: z
      .object({
        estimatedSeconds: z.number().nonnegative().optional(),
        observedAt: Instant,
        pages: Count,
      })
      .optional(),
    build: Build.extend({ executableUUID: BinaryUuid.optional() }),
    connection: z.object({
      disconnectReason: z
        .enum(["link_lost", "connect_failed", "cancelled"])
        .optional(),
      lastContact: Instant.optional(),
      lastReply: Instant.optional(),
      since: Instant,
      state: z.enum(connectionStates),
    }),
    droppedMessages: Count.optional().describe(
      "Pendant messages the phone dropped since launch: a malformed fragment or one that didn't decode."
    ),
    id: z.uuid(),
    incidents: z.array(z.enum(incidentKinds)).max(16),
    observedAt: Instant,
    pendant: z.object({
      batteryPercent: z.int().optional(),
      charging: z.enum(["charging", "unverified"]).optional(),
      freePages: Count.optional(),
      totalPages: Count.optional(),
    }),
    phone: z.object({
      batteryLevel: z.number().min(0).max(1).optional(),
      charging: z.boolean().optional(),
      freeBytes: Count.optional(),
      lowPowerMode: z.boolean(),
    }),
    reason: z.enum(heartbeatReasons),
    recording: z.object({
      lastKnown: z
        .enum(["recording", "not_recording", "listening", "unknown"])
        .optional(),
      lastKnownAt: Instant.optional(),
      state: z.enum(recordingStates),
    }),
    sync: z.enum(syncPhases),
    timeZone: z
      .string()
      .refine(isTimeZone, "not an IANA time zone")
      .optional()
      .describe(
        "The phone's time zone, \"Europe/Berlin\": the owner's days and times follow it."
      ),
    wakes: z
      .object({
        bytes24h: Count,
        duplicates24h: Count,
        last24h: Count,
        lastAt: Instant.optional(),
        pagesSaved24h: Count,
      })
      .describe("Background wakes: counts only."),
  })
  .openapi("HeartbeatUpload");

export const Heartbeat = HeartbeatUpload.extend({
  receivedAt: Instant,
}).openapi("Heartbeat");

// The first `n` frames down the first path of a stack: depth 0, its first sub-frame, ...
export function topFrames(stack: CallStack | undefined, n: number): Frame[] {
  const path: Frame[] = [];
  for (const frame of stack?.frames ?? []) {
    if (path.length === n || frame.depth < path.length) {
      break;
    }
    if (frame.depth === path.length) {
      path.push(frame);
    }
  }
  return path;
}

export const attributedStack = (d: DiagnosticUpload) =>
  d.callStacks.find((s) => s.threadAttributed) ?? d.callStacks[0];

export const frameLabel = (f: Frame) =>
  `${f.binaryName ?? "?"}+0x${(f.offsetIntoBinaryTextSegment ?? 0).toString(16)}`;

type ErrorDetail = z.infer<typeof ErrorDetail>;

function errorLines(error: ErrorDetail, since: string, stackLines: number) {
  const where = error.file
    ? `${error.file}:${error.line}`
    : `${error.method} ${error.route}`;
  const code = [
    error.domain && `${error.domain} ${error.code}`,
    error.httpStatus && `HTTP ${error.httpStatus}`,
    error.serverCode,
  ].filter(Boolean);
  const stack = error.stack?.split("\n").slice(0, stackLines) ?? [];
  return [
    `${where}  ${error.type}  ${error.count}x since ${since}`,
    ...(code.length > 0 ? [code.join(", ")] : []),
    error.message,
    ...stack.map((line) => `  ${line.trim()}`),
  ];
}

// What went wrong, in a few lines for reading: the cause, and an error's detail and stack.
export function problemLines(d: DiagnosticUpload, stackLines = 64): string[] {
  const { crash, error } = d;
  const cause = [
    crash?.objcException &&
      `${crash.objcException.name}: ${crash.objcException.formatString}`,
    crash?.terminationCategory,
    crash?.terminationReason,
    crash?.signal === undefined ? null : `signal ${crash.signal}`,
    crash?.exceptionType === undefined
      ? null
      : `exception type ${crash.exceptionType}`,
    d.durationSeconds === undefined ? null : `${d.durationSeconds} s`,
    d.bytesWritten === undefined
      ? null
      : `${Math.round(d.bytesWritten / 1e6)} MB written`,
  ].filter(Boolean);
  return [
    ...(cause.length > 0 ? [cause.join("; ")] : []),
    ...(error ? errorLines(error, d.begin, stackLines) : []),
  ];
}

// The app's own binaries in a diagnostic, whose dSYMs symbolicate it: lifelog, its widgets and the
// Watch's. MetricKit sometimes leaves the app's name out, so a nameless binary counts as the app's.
const APP_BINARY = /^lifelog/i;
export const appBinaryUUIDs = (d: DiagnosticUpload) => [
  ...new Set(
    d.callStacks.flatMap((s) =>
      s.frames
        .filter((f) => !f.binaryName || APP_BINARY.test(f.binaryName))
        .map((f) => f.binaryUUID)
        .filter((uuid) => uuid !== undefined)
    )
  ),
];

// Groups repeats of one problem within a build: kind, cause, and the top three frames of the
// attributed thread. Offsets move between builds, so a new build starts new signatures.
// An error groups by where it was caught and what it was, across builds.
export function signatureOf(d: DiagnosticUpload): string {
  if (d.kind === "metrics") {
    return "metrics";
  }
  if (d.error) {
    const e = d.error;
    return [
      d.kind,
      e.file ? `${e.file}:${e.line}` : `${e.method} ${e.route}`,
      e.type,
      e.code === undefined ? undefined : `code ${e.code}`,
      e.httpStatus?.toString(),
      e.serverCode,
    ]
      .filter(Boolean)
      .join(" | ");
  }
  const { crash } = d;
  const cause =
    crash?.objcException?.name ??
    crash?.terminationCategory ??
    (crash?.signal === undefined ? undefined : `signal ${crash.signal}`);
  const frames = topFrames(attributedStack(d), 3).map(frameLabel);
  return [d.kind, cause, ...frames].filter(Boolean).join(" | ");
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Drops what is older than the retention. Run after every upload: cheap at this volume.
function prune(db: Db, now = new Date()) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  db.delete(diagnostics).where(lt(diagnostics.receivedAt, cutoff)).run();
  db.delete(heartbeats).where(lt(heartbeats.receivedAt, cutoff)).run();
}

// Returns whether it was stored; a retried upload with the same id changes nothing, except an
// app error, whose repeats within the hour come again with a higher count and replace it.
export function storeDiagnostic(db: Db, d: DiagnosticUpload) {
  const signature = signatureOf(d);
  const insert = db.insert(diagnostics).values({
    appBuild: d.build.appBuild,
    appVersion: d.build.appVersion,
    body: d,
    id: d.id,
    kind: d.kind,
    signature,
  });
  const stored = (
    d.kind === "app_error"
      ? insert.onConflictDoUpdate({
          set: { body: d, signature },
          target: diagnostics.id,
        })
      : insert.onConflictDoNothing()
  )
    .returning({ id: diagnostics.id })
    .all();
  prune(db);
  return stored.length > 0;
}

const MESSAGE_CHARS = 300;
// A failed query's message carries its parameters, which can be transcript text, so they go.
// Its cause (SQLite's reason) comes first, so the cut never drops it.
export const serverErrorMessage = (e: Error) =>
  [
    e.cause instanceof Error ? e.cause.message : "",
    e.message.split("\nparams:")[0],
  ]
    .filter(Boolean)
    .join(": ")
    .slice(0, MESSAGE_CHARS);

// A 500 the server answered, kept like an app error so one reading covers both. Only the
// stack's frames: its first line repeats the message in full.
export function storeServerError(
  db: Db,
  error: unknown,
  request: { appBuild: string; method: string; route: string }
) {
  const e = error instanceof Error ? error : new Error(String(error));
  const now = new Date().toISOString();
  storeDiagnostic(db, {
    begin: now,
    binaries: [],
    build: {
      appBuild: request.appBuild,
      appVersion: "server",
      device: "server",
      os: `bun ${Bun.version}`,
    },
    callStacks: [],
    end: now,
    error: {
      count: 1,
      httpStatus: 500,
      message: serverErrorMessage(e),
      method: request.method,
      route: request.route,
      stack: e.stack
        ?.split("\n")
        .filter((line) => line.trimStart().startsWith("at "))
        .join("\n")
        .slice(0, 8000),
      type: e.name,
    },
    id: randomUUID(),
    kind: "server_error",
    truncated: false,
  });
}

export function storeHeartbeat(db: Db, h: z.infer<typeof HeartbeatUpload>) {
  const stored = db
    .insert(heartbeats)
    .values({
      body: h,
      id: h.id,
      observedAt: new Date(h.observedAt),
      reason: h.reason,
    })
    .onConflictDoNothing()
    .returning({ id: heartbeats.id })
    .all();
  prune(db);
  if (h.timeZone) {
    refreshOwnerTimeZone(db);
  }
  return stored.length > 0;
}

// The zone the owner was in at `at`: that of the newest heartbeat observed by then that names one,
// else of the newest at all (a late delivery of an older heartbeat doesn't move it back).
export function ownerZoneAt(db: Db, at?: Date) {
  const zone = sql<string>`${heartbeats.body} ->> 'timeZone'`;
  const newest = (until?: Date) =>
    db
      .select({ zone })
      .from(heartbeats)
      .where(
        and(
          isNotNull(zone),
          until ? lte(heartbeats.observedAt, until) : undefined
        )
      )
      .orderBy(desc(heartbeats.observedAt))
      .limit(1)
      .get()?.zone;
  const found = (at && newest(at)) ?? newest();
  return found && isTimeZone(found) ? found : DEFAULT_TIME_ZONE;
}

// The owner's zone now. At startup and after each heartbeat.
export function refreshOwnerTimeZone(db: Db) {
  setOwnerTimeZone(ownerZoneAt(db));
}

export function listDiagnostics(
  db: Db,
  {
    id,
    kind,
    limit,
    since,
  }: {
    id?: string | undefined;
    kind?: DiagnosticUpload["kind"] | undefined;
    limit: number;
    since?: string | undefined;
  }
): z.infer<typeof Diagnostic>[] {
  const rows = db
    .select()
    .from(diagnostics)
    .where(
      and(
        id ? eq(diagnostics.id, id) : undefined,
        since ? gte(diagnostics.receivedAt, new Date(since)) : undefined,
        kind ? eq(diagnostics.kind, kind) : undefined
      )
    )
    .orderBy(desc(diagnostics.receivedAt))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    ...(r.body as DiagnosticUpload),
    receivedAt: r.receivedAt.toISOString(),
    signature: r.signature,
  }));
}

// Whether the Pendant records, by the one rule every reader uses (docs/processing.md, Latency):
// the last confirmed state, which the phone keeps across a lost link, else what it sees now.
export const pendantRecording = (beat: z.infer<typeof Heartbeat>) => ({
  recording: beat.recording.lastKnown ?? beat.recording.state,
  recordingKnownAt: beat.recording.lastKnownAt ?? beat.observedAt,
});

export const pendantRecords = (beat: z.infer<typeof Heartbeat> | null) =>
  beat !== null && pendantRecording(beat).recording === "recording";

export function latestHeartbeat(db: Db): z.infer<typeof Heartbeat> | null {
  const row = db
    .select()
    .from(heartbeats)
    .orderBy(desc(heartbeats.observedAt))
    .limit(1)
    .get();
  return row
    ? {
        ...(row.body as z.infer<typeof HeartbeatUpload>),
        receivedAt: row.receivedAt.toISOString(),
      }
    : null;
}
