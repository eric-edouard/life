import { gogCall } from "../core/gog";
import { exec, execOk } from "../core/proc";
import { redact } from "../core/redact";
import type { Draft } from "../memory/calendar-events";

// One Google calendar through `gog` (as `account`), for Life's own events in it: the Past calendar
// (`past-calendar.ts`) and the appointments (`appointments-calendar.ts`). Life finds its events by their private
// properties and reads nothing else of a calendar.

/** One of Life's events: its id, whether it is all-day, and its private properties. */
interface HeldEvent {
  allDay: boolean;
  id: string;
  props: Record<string, string>;
}

/** What Life writes on an event: a draft's when and title, and what each output adds. */
type EventFields = Pick<Draft, "allDay" | "from" | "summary" | "to"> & {
  /** Busy, else shown as free. */
  busy: boolean;
  description: string;
  location: string | null;
  /** Its own reminders (`method:duration`) in place of the calendar's defaults. */
  reminders?: string[];
};

/** Google says an event is gone: not found, or deleted. */
const GONE = /\b(404|410)\b/;

const Listed = (stdout: string) =>
  JSON.parse(stdout) as {
    events?: {
      extendedProperties?: { private?: Record<string, string> };
      id: string;
      start?: { date?: string };
      status?: string;
    }[];
    nextPageToken?: string;
  };

/**
 * `gog` takes values as `--flag=value`: a model-written title starting with "-" must not read as a flag. An update
 * sends an empty location to clear it; a create leaves it out.
 */
const flagsOf = (
  f: EventFields,
  props: Record<string, string>,
  isUpdate: boolean
) => [
  `--summary=${redact(f.summary)}`,
  `--from=${f.from}`,
  `--to=${f.to}`,
  ...(f.allDay ? ["--all-day"] : []),
  `--description=${f.description}`,
  ...(f.location || isUpdate
    ? [`--location=${f.location ? redact(f.location) : ""}`]
    : []),
  `--transparency=${f.busy ? "busy" : "free"}`,
  ...(f.reminders ?? []).map((r) => `--reminder=${r}`),
  ...Object.entries(props).map(([k, v]) => `--private-prop=${k}=${v}`),
];

export function googleCalendar(calendar: string, account: string) {
  const run = (rest: string[]) => execOk(...gogCall("calendar", account, rest));
  return {
    async create(f: EventFields, props: Record<string, string>) {
      const out = await run([
        "create",
        calendar,
        ...flagsOf(f, props, false),
        "--send-updates=none",
      ]);
      return (JSON.parse(out) as { event: { id: string } }).event.id;
    },
    /** Whether event `id` is still there: false only when Google says it is gone; any other failure throws. */
    async exists(id: string) {
      const r = await exec(
        ...gogCall("calendar", account, ["event", calendar, id])
      );
      if (r.code !== 0) {
        if (GONE.test(r.stderr)) {
          return false;
        }
        throw new Error(`gog calendar event: ${r.stderr.trim().slice(-400)}`);
      }
      return (
        (JSON.parse(r.stdout) as { event?: { status?: string } }).event
          ?.status !== "cancelled"
      );
    },
    /** Life's events from `from` to `to` (RFC3339): every one with private properties, or only those matching `filter` (`key=value`). */
    async list(from: string, to: string, filter?: string) {
      const held: HeldEvent[] = [];
      let page = "";
      do {
        const r = Listed(
          // biome-ignore lint/performance/noAwaitInLoops: pages follow one another
          await run([
            "events",
            calendar,
            `--from=${from}`,
            `--to=${to}`,
            "--max=2500",
            ...(filter ? [`--private-prop-filter=${filter}`] : []),
            ...(page ? [`--page=${page}`] : []),
          ])
        );
        for (const e of r.events ?? []) {
          const props = e.extendedProperties?.private;
          if (props && e.status !== "cancelled") {
            held.push({ allDay: e.start?.date !== undefined, id: e.id, props });
          }
        }
        page = r.nextPageToken ?? "";
      } while (page);
      return held;
    },
    async remove(id: string) {
      await run(["delete", calendar, id, "--force"]);
    },
    async update(id: string, f: EventFields, props: Record<string, string>) {
      await run(["update", calendar, id, ...flagsOf(f, props, true)]);
    },
  };
}
export type GoogleCalendar = ReturnType<typeof googleCalendar>;
