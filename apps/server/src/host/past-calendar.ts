import { z } from "zod";
import { clock, DAY, daysBefore, iso } from "../core/clock";
import { log } from "../core/log";
import { isOn } from "../core/outputs";
import { execOk } from "../core/proc";
import { redact } from "../core/redact";
import { settings } from "../core/settings";
import { type Draft, heldOf, reconcile } from "../memory/calendar-events";
import { described, wanted } from "../memory/past-events";
import { dayNow } from "../memory/zones";
import { googleCalendar } from "./google-calendar";

// The Past calendar's writes: what `memory/past-events.ts` says it should hold, brought into the `past` setting's calendar,
// a Google one through `gog` (`google-calendar.ts`, with its account) or an Apple one through the app's EventKit tool.
// Life's events are found by their private properties (episode id, hash); nothing else is read back. Each nightly tick
// runs it after its turn.

/** One of Life's events in his Apple calendar, as the EventKit tool lists it. */
const Row = z.object({ episode: z.string(), hash: z.string(), id: z.string() });
const rowsOf = (rows: z.infer<typeof Row>[]) =>
  rows.map(({ episode, ...r }) => ({ ...r, of: episode }));

/** A Past event: never busy (it is the past). */
const fields = (d: Draft, description: string, location: string | null) => ({
  ...d,
  busy: false,
  description,
  location,
});

/** The Past calendar through `gog`: what it holds of Life's (events with a hash, by episode), and its writes. */
function pastCalendar(calendar: string, account: string) {
  const cal = googleCalendar(calendar, account);
  const props = (d: Draft) => ({ lifeEpisode: d.of, lifeHash: d.hash });
  return {
    async held(from: string, until: string) {
      // Every event Life writes has a hash; one with no episode (an older Life's) is never wanted, so it goes. An
      // event of another of Life's outputs (`lifeOutput`, the appointments) in the same calendar is never touched.
      return heldOf(
        (await cal.list(from, until)).flatMap((e) =>
          e.props.lifeHash === undefined || e.props.lifeOutput !== undefined
            ? []
            : [
                {
                  allDay: e.allDay,
                  hash: e.props.lifeHash,
                  id: e.id,
                  of: e.props.lifeEpisode ?? "",
                },
              ]
        )
      );
    },
    remove: (id: string) => cal.remove(id),
    async rewrite(
      id: string,
      d: Draft,
      description: string,
      location: string | null
    ) {
      await cal.update(id, fields(d, description, location), props(d));
      return id;
    },
    async write(d: Draft, description: string, location: string | null) {
      return await cal.create(fields(d, description, location), props(d));
    },
  };
}

/**
 * The Past calendar through the app's EventKit tool (`LIFE_EVENTKIT`): his Apple calendar, Life's events found by the
 * episode and hash in their URL.
 */
function appleCalendar(calendar: string, tool: string) {
  const run = (args: string[]) =>
    execOk([tool, "calendar", ...args, `--calendar=${calendar}`]);
  return {
    async held(from: string, until: string) {
      return heldOf(
        rowsOf(
          z
            .array(Row)
            .parse(
              JSON.parse(
                await run(["held", `--from=${from}`, `--until=${until}`])
              )
            )
        )
      );
    },
    async remove(id: string) {
      await run(["delete", id]);
    },
    /** The EventKit tool has no update: the old event goes and a new one is written. */
    async rewrite(
      id: string,
      d: Draft,
      description: string,
      location: string | null
    ) {
      await this.remove(id);
      return await this.write(d, description, location);
    },
    async write(d: Draft, description: string, location: string | null) {
      const out = await run([
        "create",
        `--summary=${redact(d.summary)}`,
        `--from=${d.from}`,
        `--to=${d.to}`,
        ...(d.allDay ? ["--all-day"] : []),
        `--description=${description}`,
        ...(location ? [`--location=${redact(location)}`] : []),
        `--episode=${d.of}`,
        `--hash=${d.hash}`,
      ]);
      return (JSON.parse(out) as { id: string }).id;
    },
  };
}

/**
 * Brings the calendar in line with the episodes ending after `since` (the whole calendar without it); null when it is
 * not set up or there is no index yet.
 */
export async function syncPast(since: Date | undefined, now = clock()) {
  const { pastCalendar: past } = settings();
  if (!(past && isOn("pastCalendar"))) {
    return null;
  }
  // On: an account, else the app's EventKit tool.
  const cal = past.account
    ? pastCalendar(past.calendar, past.account)
    : appleCalendar(past.calendar, process.env.LIFE_EVENTKIT as string);
  const want = await wanted(now, since);
  if (!want) {
    return null;
  }
  // Listed a day earlier than the drafts: an event ending in that day whose episode is live is left as it is.
  // ponytail: an episode read again with its end moved over a day (back, or forward from an event ended before the
  // listing) keeps its old copy until the night's whole sync.
  const { create, remove, update } = reconcile(
    want.drafts,
    await cal.held(
      since ? iso(since.getTime() - DAY) : "2000-01-01T00:00:00Z",
      daysBefore(dayNow(now), -2)
    ),
    (of) => want.live.has(of)
  );
  for (const e of remove) {
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
    await cal.remove(e.id);
    log("calendar.write", { episode: e.of, event: e.id, op: "delete" });
  }
  const was = new Map(update.map((u) => [u.d, u.id]));
  for await (const { d, description, location } of described([
    ...create,
    ...update.map((u) => u.d),
  ])) {
    const old = was.get(d);
    const event = old
      ? await cal.rewrite(old, d, description, location)
      : await cal.write(d, description, location);
    log("calendar.write", {
      episode: d.of,
      event,
      op: old ? "update" : "create",
    });
  }
  return {
    events: want.drafts.length,
    removed: remove.length,
    written: create.length + update.length,
  };
}
