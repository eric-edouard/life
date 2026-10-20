import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { APPLE_EPOCH_S } from "./imessage";

// His plan: the events Atlas writes on his word to his main Google calendar, tagged `#plan` in their description, read
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

const iso = (s: number) => new Date((s + APPLE_EPOCH_S) * 1000).toISOString();

/**
 * The plan's blocks overlapping `from`–`to`, by start: one-off events only (a repeating event is stored once, as its
 * first occurrence). `account` is his Google address (`LIFE_CALENDAR` in .env); unset, there is no plan to read.
 */
export function readPlan(
  from: Date,
  to: Date,
  account = process.env.LIFE_CALENDAR,
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
            and i.start_date < ? and i.end_date > ?
          order by i.start_date`
      )
      .all(
        `/caldav/v2/${encodeURIComponent(account)}/events/`,
        PLAN_TAG,
        to.getTime() / 1000 - APPLE_EPOCH_S,
        from.getTime() / 1000 - APPLE_EPOCH_S
      )
      .map((r) => ({
        allDay: r.allDay === 1,
        end: iso(r.end),
        start: iso(r.start),
        title: r.title,
      }));
  } finally {
    db.close();
  }
}
