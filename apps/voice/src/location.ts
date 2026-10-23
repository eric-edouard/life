// The owner's location history (location_history): every fix the phone took and every visit
// iOS reported, all day. Answers "where was I then" and "how often did I go there" for a reader
// (`GET /where`, `GET /visits`). A place is named by the phone's name of a fix taken there (Apple's,
// places.ts); otherwise coordinates stand alone.

import type { Db } from "@life/voice-db";
import { locationHistory } from "@life/voice-db/schema";
import { and, asc, gte, isNotNull, lt, sql } from "drizzle-orm";
import { logChange } from "./change-log";
import { ownerTimeZone } from "./config";
import {
  type Circle,
  distanceM,
  insidePlace,
  placeName,
  SLACK_MS,
} from "./places";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// The phone takes a fix every 5 minutes while it runs: one this close still says where the owner was.
const NEAR_MS = 30 * MINUTE;
// Points this close to a stay's most accurate one belong to it.
const STAY_RADIUS_M = 150;
// Longer than this without a point and a stay ends: nothing says the owner stayed.
const MAX_GAP_MS = 2 * HOUR;
// Rows read before a range, so a stay or a visit that began earlier is whole.
const LOOKBACK_MS = 48 * HOUR;
// ponytail: a visit iOS never closed lasts at most this long; trust later fixes over it.
const OPEN_VISIT_MS = 24 * HOUR;
// Coordinates alone name a place this wide.
const DEFAULT_RADIUS_M = 100;

// ---- Storing ----------------------------------------------------------------

interface FixIn {
  accuracyM: number;
  latitude: number;
  longitude: number;
  observedAt: string;
  placeName?: string | undefined;
}
interface VisitIn {
  accuracyM: number;
  arrivedAt: string | null;
  departedAt: string | null;
  latitude: number;
  longitude: number;
}

// Idempotent: one fix per instant (a name sent later fills a fix stored without); a visit sent
// again (now with its departure) replaces itself. A named fix changes the place of the live
// conversations around it: they are logged for the feed.
export function storeHistory(
  db: Db,
  { fixes, visits }: { fixes: FixIn[]; visits: VisitIn[] }
) {
  const storedFixes = fixes.length
    ? db.transaction((tx) => {
        const rows = tx
          .insert(locationHistory)
          .values(
            fixes.map((f) => ({
              ...f,
              observedAt: new Date(f.observedAt),
              source: "fix" as const,
            }))
          )
          .onConflictDoUpdate({
            set: { placeName: sql`excluded.place_name` },
            setWhere: sql`${locationHistory.placeName} is null and excluded.place_name is not null`,
            target: [locationHistory.observedAt, locationHistory.source],
          })
          .returning({
            at: locationHistory.observedAt,
            name: locationHistory.placeName,
          })
          .all();
        logChange(tx, "conversation", around(tx, rows));
        return rows;
      })
    : [];
  // One row per instant in a batch: the last one sent wins.
  const byInstant = new Map(
    visits.map((v) => {
      const observedAt = new Date(v.arrivedAt ?? v.departedAt ?? "");
      return [observedAt.getTime(), { ...v, observedAt }];
    })
  );
  const storedVisits = byInstant.size
    ? db
        .insert(locationHistory)
        .values(
          [...byInstant.values()].map((v) => ({
            accuracyM: v.accuracyM,
            arrivedAt: v.arrivedAt ? new Date(v.arrivedAt) : null,
            departedAt: v.departedAt ? new Date(v.departedAt) : null,
            latitude: v.latitude,
            longitude: v.longitude,
            observedAt: v.observedAt,
            source: "visit" as const,
          }))
        )
        .onConflictDoUpdate({
          set: {
            accuracyM: sql`excluded.accuracy_m`,
            arrivedAt: sql`excluded.arrived_at`,
            departedAt: sql`excluded.departed_at`,
            latitude: sql`excluded.latitude`,
            longitude: sql`excluded.longitude`,
          },
          target: [locationHistory.observedAt, locationHistory.source],
        })
        .returning({ id: locationHistory.id })
        .all()
    : [];
  return { fixes: storedFixes.length, visits: storedVisits.length };
}

// The live conversations within a fix's reach (places.ts) of a newly named fix.
function around(
  tx: Pick<Db, "all">,
  fixes: { at: Date; name: string | null }[]
) {
  const named = fixes.filter((f) => f.name !== null);
  if (named.length === 0) {
    return [];
  }
  const rows = tx.all<{ id: string }>(sql`
    select distinct c.id from conversations c
    join json_each(${JSON.stringify(named.map((f) => f.at.getTime()))}) f
      on f.value between c.capture_started_at - ${SLACK_MS}
        and c.capture_ended_at + ${SLACK_MS}
    where c.retired_at is null`);
  return rows.map((r) => r.id);
}

// ---- Grouping (pure) --------------------------------------------------------

// A fix is an instant; a visit spans its arrival to its departure.
export interface Point {
  accuracyM: number;
  from: number;
  latitude: number;
  longitude: number;
  to: number;
  visit: boolean;
}

// Consecutive points that belong together, from the first one's start to the last one's end.
interface Run {
  best: Point;
  from: number;
  points: Point[];
  to: number;
}

type Row = typeof locationHistory.$inferSelect;

// Rows as points, by start. A visit still open lasts until the next point, or now.
function toPoints(rows: Row[], now: number): Point[] {
  const points = rows
    .map((r) => {
      const from = (r.arrivedAt ?? r.observedAt).getTime();
      return {
        accuracyM: r.accuracyM,
        from,
        latitude: r.latitude,
        longitude: r.longitude,
        open: r.source === "visit" && r.departedAt === null,
        to: (r.departedAt ?? r.observedAt).getTime(),
        visit: r.source === "visit",
      };
    })
    .sort((a, b) => a.from - b.from);
  return points.map(({ open, ...p }, k) => {
    if (!open) {
      return p;
    }
    const next = points[k + 1]?.from ?? now;
    return {
      ...p,
      to: Math.max(p.from, Math.min(next, p.from + OPEN_VISIT_MS)),
    };
  });
}

// Splits time-ordered points into runs: a point joins the run before it when `together` says
// so and nothing was heard for at most MAX_GAP_MS between them.
function runs(
  points: Point[],
  together: (run: Run, point: Point) => boolean
): Run[] {
  const out: Run[] = [];
  for (const p of points) {
    const run = out.at(-1);
    if (run && p.from - run.to <= MAX_GAP_MS && together(run, p)) {
      run.points.push(p);
      run.to = Math.max(run.to, p.to);
      if (p.accuracyM < run.best.accuracyM) {
        run.best = p;
      }
    } else {
      out.push({ best: p, from: p.from, points: [p], to: p.to });
    }
  }
  return out;
}

// The owner stayed: iOS saw a visit, or two fixes in a row were taken there.
const isStay = (run: Run) =>
  run.points.some((p) => p.visit) || run.points.length >= 2;

const near = (run: Run, p: Point) => distanceM(run.best, p) <= STAY_RADIUS_M;

// Where stays and passing fixes were, in order.
const stays = (points: Point[]) => runs(points, near);

// How far `at` is from a point's span, 0 inside it.
const away = (p: Point, at: number) => Math.max(0, p.from - at, at - p.to);

type Located =
  | { kind: "stay"; run: Run }
  | { kind: "point"; point: Point }
  | { kind: "unknown"; after: Point | null; before: Point | null };

// Where the owner was at `at`: the stay around it, else the nearest point within NEAR_MS,
// else the last point before and the first after.
export function locate(points: Point[], at: number): Located {
  const run = stays(points).find(
    (r) => isStay(r) && r.from <= at && at <= r.to
  );
  if (run) {
    return { kind: "stay", run };
  }
  const nearest = points.reduce<Point | null>(
    (best, p) => (best && away(best, at) <= away(p, at) ? best : p),
    null
  );
  if (nearest && away(nearest, at) <= NEAR_MS) {
    return { kind: "point", point: nearest };
  }
  return {
    after: points.find((p) => p.from > at) ?? null,
    before: points.findLast((p) => p.to < at) ?? null,
    kind: "unknown",
  };
}

// Each stay inside any circle; points elsewhere in between end it. A point too coarse to tell
// says nothing either way.
export function visitsIn(points: Point[], circles: Circle[]) {
  const inside = (p: Point) => circles.some((c) => insidePlace(p, c));
  const telling = points.filter((p) =>
    circles.some((c) => p.accuracyM <= Math.max(c.radiusM, 100))
  );
  return runs(telling, (run, p) => inside(run.best) === inside(p)).filter(
    (r) => inside(r.best) && isStay(r)
  );
}

// ---- Time -------------------------------------------------------------------

// The UTC instant of a wall-clock time ("2026-10-09T14:30") in an IANA zone.
export function zonedInstant(local: string, zone: string) {
  const wall = Date.parse(`${local}Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: zone,
    year: "numeric",
  });
  const offset = (t: number) => {
    const all = parts.formatToParts(t);
    const f = (type: Intl.DateTimeFormatPartTypes) =>
      Number(all.find((p) => p.type === type)?.value);
    return (
      Date.UTC(
        f("year"),
        f("month") - 1,
        f("day"),
        f("hour"),
        f("minute"),
        f("second")
      ) -
      Math.floor(t / 1000) * 1000
    );
  };
  // Twice: the offset at the first guess may differ from the one at the answer (DST).
  return new Date(wall - offset(wall - offset(wall)));
}

// Midnight starting a day and the next, in the owner's zone.
function dayBounds(isoDate: string) {
  const next = new Date(Date.parse(`${isoDate}T00:00Z`) + 24 * HOUR)
    .toISOString()
    .slice(0, 10);
  return {
    from: zonedInstant(`${isoDate}T00:00`, ownerTimeZone()),
    to: zonedInstant(`${next}T00:00`, ownerTimeZone()),
  };
}

// ---- Reading ----------------------------------------------------------------

function pointsBetween(db: Db, from: number, to: number) {
  const rows = db
    .select()
    .from(locationHistory)
    .where(
      and(
        gte(locationHistory.observedAt, new Date(from - LOOKBACK_MS)),
        lt(locationHistory.observedAt, new Date(to))
      )
    )
    .orderBy(asc(locationHistory.observedAt))
    .all();
  return toPoints(rows, Date.now());
}

// The circles a place stands for: the fixes the phone named so, the name matched in part and in
// any case ("école" finds "École"; SQLite's own matching folds ASCII only).
// ponytail: one circle per ~11 m of fixes, named ones read whole; fine for months of history.
function placeCircles(db: Db, place: string) {
  const wanted = place.toLocaleLowerCase();
  return db
    .selectDistinct({
      latitude: sql<number>`round(${locationHistory.latitude}, 4)`,
      longitude: sql<number>`round(${locationHistory.longitude}, 4)`,
      name: locationHistory.placeName,
    })
    .from(locationHistory)
    .where(isNotNull(locationHistory.placeName))
    .all()
    .filter((f) => f.name?.toLocaleLowerCase().includes(wanted))
    .map(({ latitude, longitude }) => ({
      latitude,
      longitude,
      radiusM: STAY_RADIUS_M,
    }));
}

// ---- Visits -------------------------------------------------------------------

// A stay as `GET /where` and `GET /visits` give it: the phone's name for the place when it has one,
// the most accurate point, and when the owner arrived and left.
export interface Visit {
  arrivedAt: string;
  latitude: number;
  leftAt: string;
  longitude: number;
  place?: string;
}
const MAX_VISITS = 200;

function visitOf(
  db: Db,
  from: number,
  to: number,
  at: { latitude: number; longitude: number }
): Visit {
  const place = placeName(db, from, to);
  return {
    arrivedAt: new Date(from).toISOString(),
    latitude: at.latitude,
    leftAt: new Date(to).toISOString(),
    longitude: at.longitude,
    ...(place ? { place } : {}),
  };
}

// Where the owner was: at an instant, the stay around it or the nearest point within 30 minutes
// (none otherwise); on a day (owner's time zone), each stay in order.
export function whereVisits(
  db: Db,
  when: { at: Date } | { day: string }
): Visit[] {
  if ("at" in when) {
    const t = when.at.getTime();
    const found = locate(pointsBetween(db, t, t + 24 * HOUR), t);
    if (found.kind === "stay") {
      return [visitOf(db, found.run.from, found.run.to, found.run.best)];
    }
    return found.kind === "point"
      ? [visitOf(db, found.point.from, found.point.to, found.point)]
      : [];
  }
  const { from, to } = dayBounds(when.day);
  const [start, end] = [from.getTime(), Math.min(to.getTime(), Date.now())];
  const found = stays(pointsBetween(db, start, end + MAX_GAP_MS)).filter(
    (r) => isStay(r) && r.to >= start && r.from < end
  );
  return found.map((r) => visitOf(db, r.from, r.to, r.best));
}

// Each visit to a named place or a circle within [from, to) (the whole history by default),
// newest first, at most 200. Null when no place the phone named matches.
// ponytail: reads every point in the range into memory (~100k a year); page it if years pile up.
export function visitsTo(
  db: Db,
  target:
    | { place: string }
    | { latitude: number; longitude: number; radiusM?: number | undefined },
  range: { from?: Date | undefined; to?: Date | undefined }
) {
  const circles =
    "place" in target
      ? placeCircles(db, target.place)
      : [{ ...target, radiusM: target.radiusM ?? DEFAULT_RADIUS_M }];
  if (circles.length === 0) {
    return null;
  }
  const from = range.from?.getTime() ?? 0;
  const to = range.to?.getTime() ?? Date.now();
  const found = visitsIn(pointsBetween(db, from, to + MAX_GAP_MS), circles)
    .filter((r) => r.to >= from && r.from < to)
    .reverse()
    .slice(0, MAX_VISITS);
  return found.map((r) => visitOf(db, r.from, r.to, r.best));
}
