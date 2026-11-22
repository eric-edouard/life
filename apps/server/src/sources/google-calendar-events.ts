import { gogCall } from "../core/gog";
import { execOk } from "../core/proc";

/** One event of a Google calendar as gog lists it: what Life reads of it. */
export interface CalendarEvent {
  attendees?: {
    displayName?: string;
    email?: string;
    resource?: boolean;
    responseStatus?: string;
    self?: boolean;
  }[];
  end?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
  id: string;
  start?: { date?: string; dateTime?: string };
  status?: string;
  summary?: string;
}

/**
 * The one listing of a Google calendar (`calendar`, through `gog` as `account`): its events from `from` to `to` (RFC3339),
 * every page, cancelled ones left out. `filter` (`key=value`) keeps those with that private property. Read only; a
 * failure throws.
 */
export async function readCalendarEvents(
  calendar: string,
  account: string,
  from: string,
  to: string,
  filter?: string
) {
  const events: CalendarEvent[] = [];
  let page = "";
  do {
    const r = JSON.parse(
      // biome-ignore lint/performance/noAwaitInLoops: pages follow one another
      await execOk(
        ...gogCall("calendar", account, [
          "events",
          calendar,
          `--from=${from}`,
          `--to=${to}`,
          "--max=2500",
          ...(filter ? [`--private-prop-filter=${filter}`] : []),
          ...(page ? [`--page=${page}`] : []),
        ])
      )
    ) as { events?: CalendarEvent[]; nextPageToken?: string };
    events.push(...(r.events ?? []).filter((e) => e.status !== "cancelled"));
    page = r.nextPageToken ?? "";
  } while (page);
  return events;
}
