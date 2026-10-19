import { checks } from "./actions";
import { tick } from "./board";
import { deliver } from "./events";
import {
  ALERT_AFTER_MS,
  HEALTH,
  type Health,
  NO_PUBLIC,
  type PublicState,
  polling,
  readHealth,
} from "./health";
import { hear } from "./hear";
import { log } from "./log";
import { isLocked, locked } from "./memory/guard";
import { publicReport, sendReport, watchReport } from "./memory/report";
import { reindex } from "./memory/search";
import { syncLifelogUnits } from "./memory/units";
import { codeAt, exec } from "./proc";
import { serveConnector } from "./server";
import { openStore, poll, type Store } from "./sources/lifelog";
import { ROOT } from "./truth";

// `bun life watch` (a KeepAlive LaunchAgent): long-polls lifelog's change feed into the store and, when a page changed
// anything, rebuilds the lifelog units and the index (not while the nightly holds the lock). Health is in
// derived/watch/health.json (`bun life status`); after 15 minutes without a poll it emails once, and once on recovery.
// Every 5 minutes, while the Mac is online, it also checks the public connector end to end (see `publicCheck`).
// It also hears "hey Atlas": 40 s after his last new turn in a conversation, `hear` records its asks, and every loop
// `tick` chases Atlas's tasks and mirrors them on his board (src/board.ts); `deliver` pushes the asks, nudges and
// steers not yet delivered to Atlas (src/events.ts).

const WAIT_S = 60;
const RETRY_MS = 30_000;
const PUBLIC_EVERY_MS = 5 * 60_000;
const QUIET_MS = 40_000;
/** A replay of the store (after a restart or a long sleep) never acts on speech older than this. */
const RECENT_MS = 24 * 3_600_000;
const PUBLIC_URL =
  "https://life.ericedouard.com/.well-known/oauth-protected-resource/mcp";

/** The health after one poll, and the email it calls for: `down` once an incident is 15 minutes old, `up` when it ends. */
export function afterPoll(
  prev: Health | null,
  at: Date,
  result: { cursor: string } | { error: string },
  started = at
) {
  const ok = "cursor" in result;
  const lastOkAt = ok ? at.toISOString() : (prev?.lastOkAt ?? null);
  const quietMs = at.getTime() - new Date(lastOkAt ?? started).getTime();
  const health: Health = {
    ...prev,
    alertedAt: prev?.alertedAt ?? null,
    consecutiveErrors: ok ? 0 : (prev?.consecutiveErrors ?? 0) + 1,
    cursor: ok ? result.cursor : (prev?.cursor ?? "0"),
    lagSec: Math.round(quietMs / 1000),
    lastError: ok ? null : result.error,
    lastOkAt,
    lastPollAt: at.toISOString(),
  };
  if (!(ok || health.alertedAt) && quietMs >= ALERT_AFTER_MS) {
    return { health, send: "down" as const };
  }
  return { health, send: ok && health.alertedAt ? ("up" as const) : null };
}

/**
 * One check of the public connector. Offline (the Mac has no internet) is not judged: no count, no alert. Online, the 2nd
 * failure in a row heals (restart the tunnel), the 3rd alerts once, and the first success after that says it is back.
 */
export function publicCheck(
  s: PublicState,
  c: { ok: boolean; online: boolean }
) {
  if (!c.online) {
    return { action: "none" as const, state: s };
  }
  const failures = c.ok ? 0 : s.failures + 1;
  let action: "alert" | "heal" | "none" | "recovered" = "none";
  if (c.ok && s.failures >= 3) {
    action = "recovered";
  } else if (failures === 2) {
    action = "heal";
  } else if (failures === 3) {
    action = "alert";
  }
  return { action, state: { ...s, failures } };
}

/** Conversations where he spoke (or someone unnamed did): `at` is when the last such turn arrived, `from` the earliest not yet heard, `tries` its failed hearings. */
export type Pending = Map<string, { at: number; from: string; tries: number }>;
/** A hearing whose words could not be fetched is tried again this many times, then logged lost (a restart waits on it). */
const TRIES = 5;

/** Folds turns into `pending`, each conversation due 40 s after its last one arrived; speech older than a day is left out. */
function fold(
  pending: Pending,
  turns: { at: string; conversation: string }[],
  now: number,
  tries = 0
) {
  for (const t of turns) {
    if (now - Date.parse(t.at) < RECENT_MS) {
      const p = pending.get(t.conversation);
      pending.set(t.conversation, {
        at: now,
        from: p && p.from < t.at ? p.from : t.at,
        tries: Math.max(p?.tries ?? 0, tries),
      });
    }
  }
}

/**
 * Folds the turns of one poll into `pending` and takes out the conversations quiet for 40 s (measured on arrival, not
 * on speech time), ready for `hear`. ponytail: `pending` lives in memory; a restart inside the 40 s drops those turns.
 */
export function hearings(
  pending: Pending,
  turns: { at: string; conversation: string }[],
  now: number
) {
  fold(pending, turns, now);
  const due = [...pending].filter(([, p]) => now - p.at >= QUIET_MS);
  for (const [conversation] of due) {
    pending.delete(conversation);
  }
  return due.map(([conversation, { from, tries }]) => ({
    conversation,
    from,
    tries,
  }));
}

const reach = (url: string, method: string) =>
  fetch(url, { method, signal: AbortSignal.timeout(10_000) }).catch(() => null);

/** Runs the check, heals or tells the owner by email as `publicCheck` says, and returns the new state. */
async function checkPublic(prev: PublicState): Promise<PublicState> {
  const online = (await reach("https://api.resend.com", "HEAD")) !== null;
  const ok = online && (await reach(PUBLIC_URL, "GET"))?.status === 200;
  const { action, state } = publicCheck(prev, { ok, online });
  const say = (down: boolean) => {
    const at = new Date().toISOString();
    return sendReport(
      `public-${down ? "down" : "up"}/${at}`,
      publicReport(down, at)
    );
  };
  if (action === "heal") {
    console.log(
      `${new Date().toISOString()} public connector down twice: restarting the tunnel`
    );
    await exec([
      "launchctl",
      "kickstart",
      "-k",
      `gui/${process.getuid?.()}/com.eric.cloudflared`,
    ]);
  } else if (action === "alert") {
    await say(true);
  } else if (action === "recovered") {
    await say(false);
  }
  let result: PublicState["result"] = "offline";
  if (online) {
    result = ok ? "ok" : "fail";
  }
  console.log(`${new Date().toISOString()} public check: ${result}`);
  return { ...state, checkedAt: new Date().toISOString(), result };
}

/** Sends the mail a poll calls for and returns the health with the incident's state updated; a send that fails is tried again at the next poll. */
async function notify(health: Health, send: "down" | "up" | null) {
  if (!send) {
    return health;
  }
  const incident = health.alertedAt ?? health.lastOkAt ?? health.lastPollAt;
  const since = health.lastOkAt ?? health.lastPollAt;
  const id = await sendReport(
    `watch-${send}/${incident}`,
    watchReport(send === "down", since, health.lastError ?? "")
  );
  if (!id) {
    return health;
  }
  return { ...health, alertedAt: send === "down" ? health.lastPollAt : null };
}

/** A commit changed src/ or prompts/ and no hearing waits: exit, launchd starts the new code (old code lost a request on 15 Oct by reading a renamed prompt). */
const restartDue = (running: string, pending: Pending) =>
  pending.size === 0 && codeAt(ROOT) !== running;

/** Rebuilds the lifelog units and the index holding the lock; false, nothing done, when another run holds it. */
async function syncUnits(store: Store, cursor: string) {
  const n = await locked(async () => {
    const built = await syncLifelogUnits(store);
    await reindex();
    return built;
  });
  if (n) {
    console.log(
      `${new Date().toISOString()} cursor ${cursor}: ${n.added} built, ${n.changed} updated, ${n.removed} removed`
    );
  }
  return n !== null;
}

export async function watch(): Promise<number> {
  const started = new Date();
  const running = codeAt(ROOT);
  try {
    serveConnector();
  } catch (e) {
    // The watcher matters more than the connector: it keeps polling and says why it is off.
    console.error("Connector is off:", (e as Error).message);
  }
  const store = openStore();
  // The connector's `reminders` acts from this process: its line in life-watch.log shows whether launchd reaches remctl.
  checks().then((problems) =>
    console.log(
      `${new Date().toISOString()} actions: ${problems.join("; ") || "remctl ready"}`
    )
  );
  const pending: Pending = new Map();
  let health = readHealth();
  // Units follow the store even if the last run stopped between the two.
  let dirty = true;
  // The first poll answers at once, so health and units are fresh at start; later ones hold for news.
  let more = true;
  while (!restartDue(running, pending)) {
    let result: { cursor: string } | { error: string };
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the poll loop is sequential
      const page = await poll(store, more ? 0 : WAIT_S);
      ({ more } = page);
      dirty ||= page.changed;
      for (const h of hearings(pending, page.owner, Date.now())) {
        // biome-ignore lint/performance/noAwaitInLoops: one conversation at a time
        await hear(store, h.conversation, h.from).catch((e: Error) => {
          // Words not fetched: heard again after the next quiet 40 s, never read as silence.
          const lost = h.tries + 1 >= TRIES;
          log("run.error", { error: e.message, lost, step: "watch.hear" });
          if (!lost) {
            fold(
              pending,
              [{ at: h.from, conversation: h.conversation }],
              Date.now(),
              h.tries + 1
            );
          }
        });
      }
      // Delivery first: a slow Reminders host holds up the board, never an ask.
      await deliver().catch((e: Error) =>
        log("run.error", { error: e.message, step: "events.deliver" })
      );
      await tick().catch((e: Error) =>
        log("run.error", { error: e.message, step: "tasks.tick" })
      );
      // The nightly rewrites the same unit files and index: while it holds the lock (`isLocked` spares the log a line
      // each poll), `dirty` keeps the sync due.
      if (dirty && !more && !isLocked()) {
        dirty = !(await syncUnits(store, page.cursor));
      }
      result = { cursor: page.cursor };
    } catch (e) {
      result = { error: (e as Error).message };
      console.error(new Date().toISOString(), result.error);
    }
    const next = afterPoll(health, new Date(), result, started);
    if ("error" in result && next.health.consecutiveErrors === 1) {
      log("run.error", { error: result.error, step: "watch" });
    }
    health = await notify(next.health, next.send);
    const pub = health.public ?? NO_PUBLIC;
    if (
      Date.now() - new Date(pub.checkedAt ?? 0).getTime() >=
      PUBLIC_EVERY_MS
    ) {
      health = { ...health, public: await checkPublic(pub) };
    }
    await Bun.write(HEALTH, `${JSON.stringify(health, null, 2)}\n`);
    if ("error" in result) {
      await Bun.sleep(RETRY_MS);
    }
  }
  console.log(`${new Date().toISOString()} new code: restarting`);
  return 0;
}

/** `status`: what the watcher says about itself. Non-zero when it is not polling. */
export function status(): number {
  const h = readHealth();
  if (!h) {
    console.log("watcher: never ran (no derived/watch/health.json)");
    return 1;
  }
  const ago = (iso: string | null) =>
    iso
      ? `${Math.round((Date.now() - new Date(iso).getTime()) / 1000)}s ago`
      : "never";
  const pub = h.public ?? NO_PUBLIC;
  const healthy = polling(h);
  console.log(
    [
      `watcher: ${healthy ? "ok" : "NOT POLLING"}`,
      `last poll ${ago(h.lastPollAt)}, last ok ${ago(h.lastOkAt)}`,
      `cursor ${h.cursor}, lag ${h.lagSec}s, consecutive errors ${h.consecutiveErrors}`,
      ...(h.lastError ? [`last error: ${h.lastError}`] : []),
      ...(h.alertedAt ? [`alert sent ${h.alertedAt}`] : []),
      `public connector: ${pub.result ?? "never checked"} (${ago(pub.checkedAt)}), ${pub.failures} failures in a row`,
    ].join("\n")
  );
  return healthy ? 0 : 1;
}
