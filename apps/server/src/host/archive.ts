import { existsSync } from "node:fs";
import { join } from "node:path";
import { clock, DAY, HOUR } from "../core/clock";
import { hold } from "../core/lock";
import { type LogEvent, log, recentEvents } from "../core/log";
import { errorOf } from "../core/log-line";
import { LIFE_CODE_DIR } from "../core/paths";
import { exec, readRunning } from "../core/proc";
import { openReadOnly } from "../core/sqlite";
import { ownerNamesOf } from "../memory/arrival-reader";
import { loadTruth } from "../memory/read-truth";
import { ARCHIVED, type Archived, keptStores } from "../memory/sources";
import { instantOfWall } from "../memory/zones";
import { ARCHIVE, archiveDb } from "../sources/archived";
import { copyWhatsapp } from "../sources/whatsapp";
import { importWhatsappExports } from "../sources/whatsapp-export";

// Keeps every message the Mac's WhatsApp app receives, and every LINE, Telegram, Instagram and Messenger message the bridges (or Beeper)
// hold, before a delete for everyone wipes it, and every version of each Apple Note, which Notes overwrites in place.
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

/**
 * The kept stores' apps to open: not among `running` (process names) and not opened in the last 10 minutes. A store
 * whose app can't be told now (a bridge's database mid-restart) is skipped this pass, never a crash of the archive.
 */
export const appsToOpen = (
  running: string[],
  now: number,
  opened = openedAt,
  stores = keptStores()
) =>
  stores
    .flatMap((s) => {
      try {
        return s.store.app ? [s.store.app] : [];
      } catch (error) {
        console.error(
          clock().toISOString(),
          s.name,
          "app unknown this pass",
          error
        );
        return [];
      }
    })
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
function deletedIn(name: string, since: string, media = "''") {
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
  const rows = ARCHIVED.flatMap(({ name, store }) =>
    store.deleted ? deletedIn(name, since, store.deleted.media) : []
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
// night's line, and by the nightly tick that emails him an hour in (18 Oct: a chat app's store would not open for 5 hours,
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

/** An incident counts as failing once open this long: one failed 5 s pass (a store briefly busy) is not an outage. */
export const ARCHIVE_FAILING_AFTER = HOUR;

/** The stores failing now (an incident open for `ARCHIVE_FAILING_AFTER`), by store, from the last 7 days of derived/log. */
export async function archiveFailing(now = clock().getTime()) {
  const kept = new Set(keptStores().map((s) => s.name as string));
  // A store he turned off since has no incident: it is no longer copied, so nothing would ever close it.
  return [...openIncidents(await recentEvents(ARCHIVE_LOOKBACK))].filter(
    ([name, e]) =>
      kept.has(name) && now - new Date(e.at).getTime() >= ARCHIVE_FAILING_AFTER
  );
}

/** The stores whose copy is still running (an async one, over the network): a pass skips them. */
const copying = new Set<string>();

/**
 * One pass: each kept store copied, its failures opened and closed as incidents. A sync copy runs now, in order; an
 * async one runs on without holding the others, and the next pass skips it until it ends. The promise ends with all.
 */
export function copyAll(failing: Set<string>, stores = keptStores()) {
  const ended = (name: string) => {
    if (failing.delete(name)) {
      log("run.end", { step: `archive.${name}` });
    }
  };
  const failed = (name: string, error: unknown) => {
    console.error(clock().toISOString(), name, error);
    if (!failing.has(name)) {
      failing.add(name);
      log("run.error", {
        ...errorOf(error),
        step: `archive.${name}`,
      });
    }
  };
  const running: Promise<void>[] = [];
  for (const { name, store } of stores.filter((s) => !copying.has(s.name))) {
    try {
      const copied = store.copy();
      if (copied instanceof Promise) {
        copying.add(name);
        running.push(
          copied
            .then(
              () => ended(name),
              (e) => failed(name, e)
            )
            .finally(() => copying.delete(name))
        );
      } else {
        ended(name);
      }
    } catch (error) {
      failed(name, error);
    }
  }
  return Promise.all(running);
}

/**
 * `archive` runs until a commit changes the code (the app starts it again), `archive --once` once,
 * `archive deleted [days]` prints deleted messages; `archive whatsapp <folder>` copies a full older store once.
 */
export async function archiveCommand(args: string[]): Promise<number> {
  if (args[0] === "deleted") {
    printDeleted(Number(args[1] ?? 7));
    return 0;
  }
  if (args[0] === "whatsapp") {
    const [, folder] = args;
    if (
      args.length !== 2 ||
      !folder ||
      !existsSync(join(folder, "ChatStorage.sqlite"))
    ) {
      console.error(
        "usage: bun life archive whatsapp <folder containing ChatStorage.sqlite>"
      );
      return 2;
    }
    await hold("archive");
    console.log(
      `${copyWhatsapp(folder, ARCHIVE, clock().getTime(), true)} new WhatsApp message versions`
    );
    return 0;
  }
  const running = readRunning(LIFE_CODE_DIR);
  // A hand `--once` too: while the service runs, it would be a second archiver.
  await hold("archive");
  const failing = new Set(
    openIncidents(await recentEvents(ARCHIVE_LOOKBACK)).keys()
  );
  const ownerNames = ownerNamesOf(await loadTruth());
  await copyAll(failing);
  readWhatsappExports(ownerNames);
  while (readRunning(LIFE_CODE_DIR) === running) {
    if (args.includes("--once")) {
      return 0;
    }
    // ponytail: 5 s poll; a message sent and deleted within one tick is missed. Watch the WAL file if that matters.
    // biome-ignore lint/performance/noAwaitInLoops: sequential poll loop
    await Promise.all([keepAppsOpen(), Bun.sleep(5000)]);
    copyAll(failing);
    readWhatsappExports(ownerNames);
  }
  console.log(`${clock().toISOString()} new code or sources: restarting`);
  return 0;
}

/** The WhatsApp export copies read since this process started: one that failed is retried only by a new one (an update). */
const triedExports = new Set<string>();

/**
 * One pass over the copies of WhatsApp exports he dropped (`importWhatsappExports`): their messages land in the
 * archive as export rows. A copy Life does not know is logged as its shape alone and skipped: no night fails on it.
 */
function readWhatsappExports(ownerNames: string[]) {
  try {
    const { added, failed } = importWhatsappExports(triedExports, {
      atWall: instantOfWall,
      ownerNames,
    });
    if (added > 0) {
      console.log(
        `${clock().toISOString()} ${added} WhatsApp messages from an export`
      );
    }
    for (const report of failed) {
      log("run.error", { ...report.fields, step: "archive.whatsapp-export" });
    }
  } catch (error) {
    // Not a shape Life can report (a disk, a store): an incident of the archive's own, as any store's.
    console.error(clock().toISOString(), "whatsapp export", error);
    log("run.error", {
      ...errorOf(error),
      step: "archive.whatsapp-export",
    });
  }
}
