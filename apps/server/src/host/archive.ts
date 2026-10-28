import { existsSync } from "node:fs";
import { join } from "node:path";
import { clock, DAY } from "../core/clock";
import { hold } from "../core/lock";
import { type LogEvent, log, recentEvents } from "../core/log";
import { LIFE_CODE_DIR } from "../core/paths";
import { codeAt, exec } from "../core/proc";
import { openReadOnly } from "../core/sqlite";
import { ARCHIVED, type Archived, keptStores } from "../memory/sources";
import { ARCHIVE, archiveDb } from "../sources/archived";

// Keeps every message the Mac's WhatsApp app receives, and every LINE, Telegram and Instagram message Beeper Desktop
// holds, before a delete for everyone wipes it, and every version of each Apple Note, which Notes overwrites in place.
// The only copy of what an app wiped is one taken while it existed. The apps' stores are opened read-only; only the
// archive is written (one SQLite file per source). Each source copies its own store (`store` in its descriptor); one
// app being closed or locked never stops the others. Query the deleted ones with `archive deleted`.

/** When the archive last copied anything into a store (a new message or note version); null: none yet, or no store. */
export function lastCopied({ name, store }: Archived, dir = ARCHIVE) {
  const path = archiveDb(name, dir);
  if (!existsSync(path)) {
    return null;
  }
  const db = openReadOnly(path);
  try {
    return (
      db
        .query<{ at: string | null }, []>(
          `select max(seenAt) as at from ${store.copies}`
        )
        .get()?.at ?? null
    );
  } finally {
    db.close();
  }
}

// An app opened less than 10 minutes ago is not opened again, so one that fails to start is not relaunched every pass.
const REOPEN_MS = 600_000;
const openedAt = new Map<string, number>();

/** The kept stores' apps to open: not among `running` (process names) and not opened in the last 10 minutes. */
export const appsToOpen = (
  running: string[],
  now: number,
  opened = openedAt,
  stores = keptStores()
) =>
  stores
    .map((s) => s.store.app)
    .filter(
      (app) =>
        !running.includes(app) && now - (opened.get(app) ?? 0) >= REOPEN_MS
    );

/**
 * Opens each store's app that is not running, hidden and in the background (`ps -c` names them as `store.app` does), each
 * `open` given 5 s at most, so a hung LaunchServices never holds up the copies.
 */
async function keepAppsOpen() {
  const now = clock().getTime();
  const running = (await exec(["ps", "-axco", "comm="])).stdout.split("\n");
  await Promise.all(
    appsToOpen(running, now).map(async (app) => {
      openedAt.set(app, now);
      const { code, stderr } = await exec(["open", "-g", "-j", "-a", app], {
        timeout: 5000,
      });
      console.log(
        `${new Date(now).toISOString()} opened ${app}${code ? `: failed, ${stderr.trim()}` : ""}`
      );
    })
  );
}

/** The deleted messages one store kept since `since`, opened read-only: the archive is their only copy. */
function deletedIn(name: string, media: string, since: string) {
  const path = archiveDb(name);
  if (!existsSync(path)) {
    return [];
  }
  const db = openReadOnly(path);
  try {
    return db
      .query<
        {
          at: string;
          chatName: string | null;
          media: string;
          senderName: string | null;
          text: string;
        },
        [string]
      >(
        `select at, chatName, senderName, text, ${media} as media from deleted where deletedSeenAt > ?`
      )
      .all(since);
  } finally {
    db.close();
  }
}

function printDeleted(days: number) {
  const since = new Date(clock().getTime() - days * DAY).toISOString();
  const rows = ARCHIVED.flatMap((s) =>
    deletedIn(s.name, s.store.media, since)
  ).sort((a, b) => a.at.localeCompare(b.at));
  for (const r of rows) {
    const media = r.media ? ` [${join(ARCHIVE, "media", r.media)}]` : "";
    console.log(
      `${r.at}  ${r.chatName ?? "?"}${r.senderName ? ` · ${r.senderName}` : ""}: ${r.text.replaceAll("\n", " ")}${media}`
    );
  }
}

// A store failing since its first failed pass until its next good one is an incident, logged at both ends
// (`archive.<store>`: run.error, run.end). The log is its only record: read back on a restart (each commit), by the
// night's line, and by the nightly tick that emails him an hour in (18 Oct: Beeper's store would not open for 5 hours,
// unseen, and what is deleted meanwhile is lost).

// ponytail: an incident open over 7 days drops out of the window until the archive restarts and logs it again.
export const ARCHIVE_LOOKBACK = 7;

/** The incidents open at the end of `lines` (run events, oldest first): each store's first failed pass. */
export function openIncidents(lines: LogEvent[]) {
  const started = new Map<string, LogEvent>();
  for (const e of lines.filter((l) => l.step.startsWith("archive."))) {
    const name = e.step.slice("archive.".length);
    if (e.kind === "run.error") {
      started.set(name, e);
    } else {
      started.delete(name);
    }
  }
  return started;
}

/** The stores failing for at least `ms` at `now`, by store, from the last 7 days of derived/log. */
export async function archiveFailing(ms = 0, now = clock().getTime()) {
  const kept = new Set(keptStores().map((s) => s.name as string));
  // A store he turned off since has no incident: it is no longer copied, so nothing would ever close it.
  return [...openIncidents(await recentEvents(ARCHIVE_LOOKBACK))].filter(
    ([name, e]) => kept.has(name) && now - Date.parse(e.at) >= ms
  );
}

/**
 * `archive` runs until a commit changes the code (the LaunchAgent starts it again), `archive --once` once,
 * `archive deleted [days]` prints deleted messages.
 */
export async function archiveCommand(args: string[]): Promise<number> {
  if (args[0] === "deleted") {
    printDeleted(Number(args[1] ?? 7));
    return 0;
  }
  const running = codeAt(LIFE_CODE_DIR);
  // A hand `--once` too: while the service runs, it would be a second archiver.
  await hold("archive");
  const failing = new Set((await archiveFailing()).map(([name]) => name));
  while (codeAt(LIFE_CODE_DIR) === running) {
    for (const { name, store } of keptStores()) {
      try {
        const added = store.copy();
        if (failing.delete(name)) {
          log("run.end", { step: `archive.${name}` });
        }
        if (added > 0) {
          console.log(`${clock().toISOString()} archived ${added} ${name}`);
        }
      } catch (error) {
        console.error(clock().toISOString(), name, error);
        if (!failing.has(name)) {
          failing.add(name);
          log("run.error", {
            error: (error as Error).message,
            step: `archive.${name}`,
          });
        }
      }
    }
    if (args.includes("--once")) {
      return 0;
    }
    // ponytail: 5 s poll; a message sent and deleted within one tick is missed. Watch the WAL file if that matters.
    // biome-ignore lint/performance/noAwaitInLoops: sequential poll loop
    await Promise.all([keepAppsOpen(), Bun.sleep(5000)]);
  }
  console.log(`${clock().toISOString()} new code: restarting`);
  return 0;
}
