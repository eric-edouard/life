import { clock } from "../core/clock";
import { redact } from "../core/redact";
import {
  conversationsBetween,
  openStore,
  type Stay,
  visits,
  whereAt,
  withStore,
} from "../sources/lifelog";
import { clip, dayRange, isDay, localTime, time } from "./units";
import { asData } from "./words";

// `bun life memory places`, and the connector's `read_places_visited`: where the owner was (lifelog's stays, from the iPhone's
// location history), each stay with the titles of the conversations recorded during it, joined here from Life's store.
// Coordinates come from the asker: Life does no geocoding.

const MAX = 200;
const TITLES = 5;

export interface PlacesQuery {
  /** An ISO instant (the stay at that moment) or a YYYY-MM-DD date (that day's stays). */
  at?: string;
  from?: string;
  latitude?: number;
  longitude?: number;
  /** A place name, or part of one. */
  place?: string;
  radiusM?: number;
  to?: string;
}

export const where = (s: Stay) =>
  `${s.place ?? "unnamed place"} (${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)})`;

/** Where he was from `from` to `to` (ISO instants): the stay that covers the most of it; a stay not left is open. */
export function stayOf(from: string, to: string, stays: Stay[]) {
  const [a, b] = [Date.parse(from), Date.parse(to)];
  const covered = (s: Stay) =>
    Math.min(b, Date.parse(s.leftAt ?? to)) -
    Math.max(a, Date.parse(s.arrivedAt));
  return stays.reduce<Stay | undefined>(
    (best, s) =>
      covered(s) > 0 && (!best || covered(s) > covered(best)) ? s : best,
    undefined
  );
}

/** The stays for a question, newest first; null when it names nothing to look for. */
export async function placesOf(
  q: PlacesQuery,
  read = { visits, where: whereAt },
  open = openStore
) {
  const located = q.latitude !== undefined && q.longitude !== undefined;
  if (!(q.at || q.place || located)) {
    return null;
  }
  // A date is a day of his, bounded where he was then (Life's zones): lifelog only takes instants.
  const day = q.at && isDay(q.at) ? q.at : undefined;
  const range = day ? dayRange(day, day) : dayRange(q.from, q.to);
  const now = clock().toISOString();
  const stays = (
    q.at && !day
      ? await read.where(q.at)
      : await read.visits({
          from: range.from,
          latitude: q.latitude,
          longitude: q.longitude,
          place: q.place,
          radiusM: q.radiusM,
          to: range.to,
        })
  )
    // Nothing after now: a stay not left by then is open.
    .filter((s) => s.arrivedAt <= now)
    .map((s) => (s.leftAt && s.leftAt > now ? { ...s, leftAt: null } : s))
    .slice(0, MAX);
  return withStore(
    (store) =>
      asData([
        `Stays (${stays.length}${stays.length === MAX ? ", the newest; narrow the dates for more" : ""}; newest first; \`fetch <id>\` for a recorded conversation):`,
        ...stays.flatMap((s) => {
          const left = s.leftAt ?? now;
          const during = conversationsBetween(store, s.arrivedAt, left);
          return [
            `- ${localTime(s.arrivedAt)}–${s.leftAt ? time(s.leftAt) : "now"} ${redact(where(s))}`,
            ...during
              .slice(0, TITLES)
              .map(
                (c) =>
                  `    ${c.id} ${time(c.start_at)} ${clip(redact(c.title), 80)}`
              ),
            ...(during.length > TITLES
              ? [`    (${during.length - TITLES} more conversations)`]
              : []),
          ];
        }),
      ]),
    open
  );
}
