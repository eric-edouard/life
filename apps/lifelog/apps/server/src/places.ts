// Place names, from the phone's location history: each fix may carry Apple's name for where it was
// taken (`placeName`, reverse-geocoded on the phone). A conversation's place, and a stay's, is the
// name of its most accurate named fix. Never from upload time.

import type { Db } from "@lifelog/db";
import { locationHistory } from "@lifelog/db/schema";
import { and, asc, gte, isNotNull, lte } from "drizzle-orm";

// ---- Geometry ---------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000;

export function distanceM(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

interface Point {
  accuracyM: number;
  latitude: number;
  longitude: number;
}
export interface Circle {
  latitude: number;
  longitude: number;
  radiusM: number;
}

// Within the radius, and accurate enough to say so.
export const insidePlace = (fix: Point, place: Circle) =>
  fix.accuracyM <= Math.max(place.radiusM, 100) &&
  distanceM(fix, place) <= place.radiusM;

// ---- Names ------------------------------------------------------------------

// A fix this far outside a range still says where it was (one is taken every 5 minutes).
export const SLACK_MS = 5 * 60_000;

// The named fixes from `from` to `to` (epoch ms), with the slack, in time order.
const namedFixes = (db: Db, from: number, to: number) =>
  db
    .select({
      accuracyM: locationHistory.accuracyM,
      at: locationHistory.observedAt,
      name: locationHistory.placeName,
    })
    .from(locationHistory)
    .where(
      and(
        isNotNull(locationHistory.placeName),
        gte(locationHistory.observedAt, new Date(from - SLACK_MS)),
        lte(locationHistory.observedAt, new Date(to + SLACK_MS))
      )
    )
    .orderBy(asc(locationHistory.observedAt))
    .all();

// The name of the most accurate named fix around [from, to], or null.
export function placeName(db: Db, from: number, to: number) {
  const fixes = namedFixes(db, from, to);
  return (
    fixes.reduce<(typeof fixes)[number] | null>(
      (best, f) => (best && best.accuracyM <= f.accuracyM ? best : f),
      null
    )?.name ?? null
  );
}
