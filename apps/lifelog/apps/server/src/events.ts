// The chain's steps, for finding where something broke: every external call the server makes
// (APNs, ElevenLabs), the Mac socket's states, quiet ranges, and what the
// phone saw (POST /events). Each is one JSON line on stdout, for the server's log, and a row in
// `events`, which outlives the log's rotation. Ids, states, counts, durations and status codes
// only: never tokens, transcript text, audio or photos. Read them with `bun run events` (repo root).

import { z } from "@hono/zod-openapi";
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { eventSources, events } from "@lifelog/db/schema";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

const RETENTION_DAYS = 14;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let prunedAt = 0;

type Value = string | number | boolean | null;
export type Fields = Record<string, Value>;

// The first characters of a push token: enough to tell two apart, useless to send with.
export const tokenPrefix = (token: string) => token.slice(0, 8);

// Logs and stores one event; never throws, so a chain step never fails for its log.
export function record(
  db: Db,
  name: string,
  fields: Fields = {},
  { at = clock(), id, source = "server" }: Partial<EventMeta> = {}
) {
  console.log(
    JSON.stringify({ at: at.toISOString(), event: name, source, ...fields })
  );
  try {
    db.insert(events)
      .values({ at, fields, id, name, source })
      .onConflictDoNothing()
      .run();
    if (clock().getTime() - prunedAt > PRUNE_EVERY_MS) {
      prunedAt = clock().getTime();
      const cutoff = new Date(
        clock().getTime() - RETENTION_DAYS * 24 * 3600 * 1000
      );
      db.delete(events).where(lt(events.at, cutoff)).run();
    }
  } catch (error) {
    console.error(`event ${name} not stored: ${String(error)}`);
  }
}

// Whether an event `name` was stored for the owner's day `day` (its `day` field): once-a-day work
// that a restart must not repeat.
export function recordedOn(db: Db, name: string, day: string) {
  const row = db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.name, name), sql`${events.fields}->>'day' = ${day}`))
    .limit(1)
    .get();
  return Boolean(row);
}

interface EventMeta {
  at: Date;
  id: string;
  source: (typeof eventSources)[number];
}

const Name = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);
const EventFields = z
  .record(
    z.string().regex(/^[a-zA-Z]\w{0,31}$/),
    z.union([z.string().max(200), z.number(), z.boolean(), z.null()])
  )
  .refine((f) => Object.keys(f).length <= 16, "at most 16 fields");

export const AppEvent = z
  .object({
    at: z.iso.datetime(),
    fields: EventFields.default({}),
    id: z.uuid().describe("The phone's; a retried event is stored once."),
    name: Name,
  })
  .openapi("AppEvent");

export const Event = z
  .object({
    at: z.iso.datetime(),
    fields: EventFields,
    id: z.uuid(),
    name: z.string(),
    source: z.enum(eventSources),
  })
  .openapi("Event");

export const storeAppEvent = (db: Db, e: z.infer<typeof AppEvent>) =>
  record(db, e.name, e.fields, {
    at: new Date(e.at),
    id: e.id,
    source: "app",
  });

// Each step's latest event since `since`, with how many there were: where each chain last got
// to, by name ("apns.sent", "activity.content_update").
export function lastSteps(db: Db, since: Date) {
  const rows = db.all<{
    at: number;
    fields: string;
    n: number;
    name: string;
  }>(sql`
    select name, at, fields, n from (
      select name, at, fields, count(*) over (partition by name) as n,
        row_number() over (partition by name order by at desc, rowid desc) as rank
      from events where at >= ${since.getTime()}
    ) where rank = 1`);
  return Object.fromEntries(
    rows.map((r) => [
      r.name,
      {
        count: r.n,
        last: new Date(r.at).toISOString(),
        ...(JSON.parse(r.fields) as Fields),
      },
    ])
  );
}

// The latest `limit` from `since`, oldest first.
export function listEvents(
  db: Db,
  { limit, since }: { limit: number; since: string }
): z.infer<typeof Event>[] {
  const rows = db
    .select()
    .from(events)
    .where(gte(events.at, new Date(since)))
    .orderBy(desc(events.at), desc(sql`${events}.rowid`))
    .limit(limit)
    .all();
  return rows.reverse().map((r) => ({
    ...r,
    at: r.at.toISOString(),
    fields: r.fields as Fields,
  }));
}
