import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { TEST } from "../truth";
import { fromAppleS, toAppleS } from "./imessage";

// His plan: the events Atlas writes on his word to his main Google calendar, tagged `#plan` in their description (never
// an invitation: those have attendees, Atlas's blocks none), read
// from the Mac's Calendar database (which syncs that calendar), opened read-only. Never written: Life writes no calendar.

const DB = join(
  homedir(),
  "Library",
  "Group Containers",
  "group.com.apple.calendar",
  "Calendar.sqlitedb"
);
export const PLAN_TAG = "#plan";
// EventKit's EKEventStatusCanceled.
const CANCELED = 3;

export interface Block {
  allDay: boolean;
  end: string;
  start: string;
  title: string;
}

/**
 * The plan's blocks overlapping `from`–`to`, by start. `account` is his Google address (`LIFE_CALENDAR` in .env);
 * unset, there is no plan to read.
 * ponytail: one-off events only (a repeating event is stored once, as its first occurrence; Atlas writes none); read
 * the OccurrenceCache table if he wants repeating blocks.
 */
export function readPlan(
  from: Date,
  to: Date,
  account = TEST ? undefined : process.env.LIFE_CALENDAR,
  path = DB
): Block[] | null {
  if (!account) {
    return null;
  }
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<
        { allDay: number; end: number; start: number; title: string },
        [string, string, number, number]
      >(
        `select i.summary as title, i.start_date as start, i.end_date as end, i.all_day as allDay
           from CalendarItem i join Calendar c on c.ROWID = i.calendar_id
          where c.external_id = ? and instr(i.description, ?) > 0 and i.status <> ${CANCELED} and not i.hidden
            and not i.has_attendees
            and i.start_date < ? and i.end_date > ?
          order by i.start_date`
      )
      .all(
        `/caldav/v2/${encodeURIComponent(account)}/events/`,
        PLAN_TAG,
        toAppleS(to.getTime()),
        toAppleS(from.getTime())
      )
      .map((r) => ({
        allDay: r.allDay === 1,
        end: fromAppleS(r.end).toISOString(),
        start: fromAppleS(r.start).toISOString(),
        title: r.title,
      }));
  } finally {
    db.close();
  }
}
