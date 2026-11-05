import { z } from "zod";
import { clock } from "../core/clock";
import { log } from "../core/log";
import { isOn } from "../core/outputs";
import { execOk } from "../core/proc";
import { redact } from "../core/redact";
import { settings } from "../core/settings";
import {
  type Draft,
  described,
  type Held,
  plan,
  wanted,
} from "../memory/past-events";
import { daysBefore } from "../memory/units";

// The Past calendar's writes: what `memory/past-events.ts` says it should hold, brought into the `past` setting's calendar,
// a Google one through `gog` (with its account) or an Apple one through the app's EventKit tool. Life's events are
// found by their private properties (episode id, hash); nothing else is read back. Each nightly tick runs it after
// its turn.

const PastEvents = (stdout: string) =>
  JSON.parse(stdout) as {
    events?: {
      extendedProperties?: { private?: Record<string, string> };
      id: string;
    }[];
    nextPageToken?: string;
  };

/** One of Life's events in a calendar: its episode, the hash it was written with, its id there. */
const Row = z.object({ episode: z.string(), hash: z.string(), id: z.string() });
type Row = z.infer<typeof Row>;
/** Life's events by episode, whichever calendar holds them. */
export const heldOf = (rows: Row[]): Held =>
  new Map(
    [...Map.groupBy(rows, (r) => r.episode)].map(([episode, rs]) => [
      episode,
      rs.map(({ hash, id }) => ({ hash, id })),
    ])
  );

/** The Past calendar through `gog`: what it holds of Life's (events with an episode id, by episode), and its writes. */
function pastCalendar(calendar: string, account: string) {
  // Values go as `--flag=value`: a model-written title starting with "-" must not read as a flag.
  const run = (args: string[]) =>
    execOk([
      "gog",
      "calendar",
      ...args,
      `--account=${account}`,
      "--json",
      "--no-input",
    ]);
  return {
    async held(until: string) {
      const rows: Row[] = [];
      let page = "";
      do {
        const r = PastEvents(
          // biome-ignore lint/performance/noAwaitInLoops: pages follow one another
          await run([
            "events",
            calendar,
            "--from=2000-01-01",
            `--to=${until}`,
            "--max=2500",
            ...(page ? [`--page=${page}`] : []),
          ])
        );
        for (const e of r.events ?? []) {
          const p = e.extendedProperties?.private;
          // Every event Life writes has a hash; one with no episode (an older Life's) is never wanted, so it goes.
          if (p?.lifeHash !== undefined) {
            rows.push({
              episode: p.lifeEpisode ?? "",
              hash: p.lifeHash,
              id: e.id,
            });
          }
        }
        page = r.nextPageToken ?? "";
      } while (page);
      return heldOf(rows);
    },
    async remove(episode: string, id: string) {
      await run(["delete", calendar, id, "--force"]);
      log("calendar.write", { episode, event: id, op: "delete" });
    },
    async write(d: Draft, description: string, location: string | null) {
      const out = await run([
        "create",
        calendar,
        `--summary=${redact(d.summary)}`,
        `--from=${d.from}`,
        `--to=${d.to}`,
        ...(d.allDay ? ["--all-day"] : []),
        `--description=${description}`,
        ...(location ? [`--location=${redact(location)}`] : []),
        "--transparency=free",
        "--send-updates=none",
        `--private-prop=lifeEpisode=${d.episode}`,
        `--private-prop=lifeHash=${d.hash}`,
      ]);
      const { id } = (JSON.parse(out) as { event: { id: string } }).event;
      log("calendar.write", { episode: d.episode, event: id, op: "create" });
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
    async held(until: string) {
      return heldOf(
        z.array(Row).parse(JSON.parse(await run(["held", `--until=${until}`])))
      );
    },
    async remove(episode: string, id: string) {
      await run(["delete", id]);
      log("calendar.write", { episode, event: id, op: "delete" });
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
        `--episode=${d.episode}`,
        `--hash=${d.hash}`,
      ]);
      const { id } = JSON.parse(out) as { id: string };
      log("calendar.write", { episode: d.episode, event: id, op: "create" });
    },
  };
}

/** Brings the calendar in line with the episodes; null when it is not set up. */
export async function syncPast(now = clock()) {
  const { past } = settings();
  if (!(past && isOn("past"))) {
    return null;
  }
  // On: an account, else the app's EventKit tool.
  const cal = past.account
    ? pastCalendar(past.calendar, past.account)
    : appleCalendar(past.calendar, process.env.LIFE_EVENTKIT as string);
  const want = await wanted(now);
  const { fresh, stale } = plan(
    want,
    await cal.held(daysBefore(now.toISOString().slice(0, 10), -2))
  );
  for (const e of stale) {
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
    await cal.remove(e.episode, e.id);
  }
  for await (const { d, description, location } of described(fresh)) {
    await cal.write(d, description, location);
  }
  return { events: want.length, removed: stale.length, written: fresh.length };
}
