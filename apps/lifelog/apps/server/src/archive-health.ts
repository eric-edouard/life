// The archive's invariants (docs/sync.md), in `GET /status`, checked every hour (index.ts) and by
// `bun run --cwd apps/server check:archive`. Each count should be 0:
// - strayTurns: turns that start in no live conversation;
// - overlaps: pairs of live conversations whose ranges overlap, so a turn would show in both;
// - deadPassages: search passages of a conversation that isn't live;
// - strandedNames: the owner's speaker names on a job no live conversation holds;
// - pagesTwice: Pendant page ranges a source's job holds that another job not failed holds too
//   (paid work happens once), and speech fragments the same (`twice`).
// A count that rose since the last check emails the owner, at most once per 12 hours.

import type { Db } from "@lifelog/db";
import { events, holdsTurn } from "@lifelog/db/schema";
import { desc, eq, type SQL, sql } from "drizzle-orm";
import { emailOwner } from "./alert";
import type { Config } from "./config";
import { record } from "./events";

const HOUR_MS = 3600 * 1000;
const ALERT_EVERY_MS = 12 * HOUR_MS;

// The page ranges of `rows` (a source's, as `source_id, pages`) starting at or before the end of an
// earlier one of the same source: each overlap counted once. Ranges in one row are disjoint.
const twice = (rows: SQL) => sql`(select count(*) from (
    select r.value ->> 0 as first, max(r.value ->> 1) over (partition by x.source_id
      order by r.value ->> 0, r.value ->> 1 rows between unbounded preceding and 1 preceding) as before
    from (${rows}) x, json_each(x.pages) r)
  where first <= before)`;

export function archiveHealth(db: Db) {
  // `get` on raw SQL gives the values alone; `all` names them.
  const [counts] = db.all<{
    deadPassages: number;
    overlaps: number;
    pagesTwice: number;
    strandedNames: number;
    strayTurns: number;
  }>(sql`
    with live as (select * from conversations where retired_at is null)
    select
      (select count(*) from turns t
        where not exists (select 1 from live c where ${holdsTurn()})) as "strayTurns",
      (select count(*) from live x join live y on x.id < y.id
        and x.capture_started_at < y.capture_ended_at and y.capture_started_at < x.capture_ended_at)
        as overlaps,
      (select count(*) from search_passages s where not exists (
        select 1 from live where live.id = s.conversation_id)) as "deadPassages",
      (select count(*) from speaker_assignments a where a.source = 'owner'
        and not exists (select 1 from conversation_jobs v where v.job_id = a.job_id))
        as "strandedNames",
      ${twice(sql`select source_id, pages from transcription_jobs
        where state <> 'failed' and pages is not null`)}
        + ${twice(sql`select source_id, pages from speech_fragments`)} as "pagesTwice"`);
  if (!counts) {
    throw new Error("the archive check returned nothing");
  }
  return counts;
}

export type ArchiveHealth = ReturnType<typeof archiveHealth>;

// The counts that rose since `before` (the last check), with their value now.
export const worse = (now: ArchiveHealth, before: Partial<ArchiveHealth>) =>
  Object.entries(now).filter(
    ([kind, n]) => n > (before[kind as keyof ArchiveHealth] ?? 0)
  );

// Checks once an hour and emails the owner when a count rose.
export function healthWatch(db: Db, config: Config) {
  let checkedAt = 0;
  return {
    async hourly(at = Date.now()) {
      if (at - checkedAt < HOUR_MS) {
        return null;
      }
      checkedAt = at;
      const last = db
        .select({ fields: events.fields })
        .from(events)
        .where(eq(events.name, "archive.checked"))
        .orderBy(desc(events.at), desc(sql`rowid`))
        .get();
      const health = archiveHealth(db);
      record(db, "archive.checked", health);
      const rose = worse(
        health,
        (last?.fields ?? {}) as Partial<ArchiveHealth>
      );
      if (rose.length > 0) {
        const status = await emailOwner(config, {
          key: `archive-${Math.floor(at / ALERT_EVERY_MS)}`,
          subject: "Lifelog: the archive breaks its invariants",
          text: `${rose.map(([kind, n]) => `${kind} ${n}`).join(", ")}.\n\nGET /status shows the details (archive-health.ts).`,
        });
        record(db, "archive.alert", { status });
      }
      return health;
    },
  };
}
export type HealthWatch = ReturnType<typeof healthWatch>;
