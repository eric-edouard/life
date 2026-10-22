import { checks, pull } from "../actions/backend";
import { marks, push } from "../actions/board";
import { clock, MIN } from "../core/clock";
import { appendJsonl } from "../core/files";
import { hold } from "../core/lock";
import { log } from "../core/log";
import { isOn } from "../core/outputs";
import { ROOT } from "../core/paths";
import { codeAt } from "../core/proc";
import { isLocked, locked } from "../memory/guard";
import { ACTIONS, readActions, tasksOf } from "../memory/ledger";
import { reindex } from "../memory/search";
import { listening } from "../memory/sources";
import { syncLifelogUnits } from "../memory/units";
import { Action } from "../records/ledger";
import { lastSeen, openStore, poll, type Store } from "../sources/lifelog";
import { deliver } from "./events";
import { HEALTH, type Health, polling, readHealth } from "./health";
import { hear, speechIn } from "./hear";
import { serve } from "./http/server";
import { healTunnel, TUNNEL_EVERY_MS } from "./http/tunnel";
import { inbound } from "./inbound";
import { chase, closings, receipts } from "./tasks";

// `bun life watch` (a KeepAlive LaunchAgent): long-polls lifelog's change feed into the store and, when a page changed
// anything, rebuilds the lifelog units and the index (not while the nightly holds the lock). Health is in
// derived/watch/health.json (`bun life status`). An outage (the Mac offline, mostly) delays, never loses: the cursor
// is gap-free and speech up to a week old is still heard, so nothing alerts on it (decided 20 Oct).
// It also hears "hey <agent>": once a conversation's speech is complete (`speechIn`, `WAIT_MS`), `hear` records its asks
// (a wake with no speaker waits for one, up to `NAMING_MS`); each minute `chase` emails him the tasks that need him and `push`
// mirrors them on his board (apps/server/src/actions); `deliver` pushes the asks not yet delivered to the agent (apps/server/src/host/events.ts).
// Every 2 minutes it probes the Mac's Cloudflare tunnel (apps/server/src/host/http/tunnel.ts), which no longer fires behind the edge Worker (#133).

let last = 0;
let ticking = false;
/** At most each minute, one at a time, beside the loop (reading his lists takes about 10 s): the chase, then Reminders both ways. */
async function tick(now = clock().getTime()) {
  if (ticking || now - last < MIN) {
    return;
  }
  last = now;
  ticking = true;
  await pass(now).finally(() => {
    ticking = false;
  });
}

async function pass(now: number) {
  await chase(tasksOf(), now);
  if (!isOn("actions")) {
    return;
  }
  // The actions backend both ways (apps/server/src/actions): one read, his changes recorded as state, then the board brought in line. `at`
  // is taken before the read: what Life writes during it falls in the lag window.
  const at = clock().toISOString();
  const read = performance.now();
  const s = await pull();
  log("sync.pull", { ms: Math.round(performance.now() - read) });
  const lines = [
    ...inbound(s, readActions(), at),
    ...closings(tasksOf(), marks(s), at),
  ];
  if (lines.length > 0) {
    appendJsonl(ACTIONS, Action, lines);
  }
  await push(receipts(tasksOf(), now), s.board);
}

const WAIT_S = 60;
const RETRY_MS = 30_000;
/**
 * How long after his last turn arrived a conversation is heard (`speechIn`): complete speech once lifelog's rows for
 * it have settled (its speaker, mostly within 3 s), open speech once the next recording is usually in. A wake with no
 * speaker yet waits longer, in `hear` (`NAMING_MS`).
 * ponytail: a recording later than that ends the ask before it (`asksIn` starts at a wake); joining it to the open
 * ask would need a ledger line that extends an ask.
 */
const WAIT_MS = { complete: 5000, open: 60_000 };
/** A replay of the store (after a restart or an outage) never acts on speech older than a week. */
const RECENT_MS = 7 * 24 * 3_600_000;
/**
 * How far before the newest turn a restarted watcher hears again: past any wait (2 min at most, 10–21 Oct), hold or
 * retry. ponytail: a hearing pending longer (five failed fetches while other turns arrive) is lost on a restart; mark
 * heard turns in the store if that ever happens.
 */
const REPLAY_S = 600;

/** The health after one poll. */
export function afterPoll(
  prev: Health | null,
  at: Date,
  result: { cursor: string } | { error: string },
  started = at
): Health {
  const ok = "cursor" in result;
  const lastOkAt = ok ? at.toISOString() : (prev?.lastOkAt ?? null);
  const quietMs = at.getTime() - new Date(lastOkAt ?? started).getTime();
  return {
    consecutiveErrors: ok ? 0 : (prev?.consecutiveErrors ?? 0) + 1,
    cursor: ok ? result.cursor : (prev?.cursor ?? "0"),
    lagSec: Math.round(quietMs / 1000),
    lastError: ok ? null : result.error,
    lastOkAt,
    lastPollAt: at.toISOString(),
  };
}

/** Conversations to hear (new turns of his or unattributed ones, at start every recent one): `at` is when the last such turn arrived, `from` the earliest not yet heard, `tries` its failed hearings. */
export type Pending = Map<string, { at: number; from: string; tries: number }>;
/** A hearing whose words could not be fetched is tried again this many times, then logged lost. */
const TRIES = 5;

/** Folds turns into `pending`, each conversation due after its last one arrived (`dueAt`); speech older than a week is left out, and logged. */
function fold(
  pending: Pending,
  turns: { at: string; conversation: string }[],
  now: number,
  tries = 0
) {
  const recent = turns.filter((t) => now - Date.parse(t.at) < RECENT_MS);
  if (recent.length < turns.length) {
    console.log(
      `${new Date(now).toISOString()} not heard: ${turns.length - recent.length} turns older than a week`
    );
  }
  for (const t of recent) {
    const p = pending.get(t.conversation);
    pending.set(t.conversation, {
      at: now,
      from: p && p.from < t.at ? p.from : t.at,
      tries: Math.max(p?.tries ?? 0, tries),
    });
  }
}

/** Where a conversation's speech stands (`speechIn`). */
type Speech = (conversation: string, from: string) => keyof typeof WAIT_MS;

/** When a pending conversation is due: `WAIT_MS` after its last turn arrived, by where its speech stands. */
const dueAt = (
  [conversation, p]: [string, { at: number; from: string }],
  speech: Speech
) => p.at + WAIT_MS[speech(conversation, p.from)];

/**
 * Folds the turns of one poll into `pending` and takes out the conversations due (`dueAt`, measured on arrival, not on
 * speech time), ready for `hear`.
 */
export function hearings(
  pending: Pending,
  turns: { at: string; conversation: string }[],
  now: number,
  speech: Speech
) {
  fold(pending, turns, now);
  const due = [...pending].filter((e) => dueAt(e, speech) <= now);
  for (const [conversation] of due) {
    pending.delete(conversation);
  }
  return due.map(([conversation, { from, tries }]) => ({
    conversation,
    from,
    tries,
  }));
}

/** Seconds the next poll may hold: until the first pending conversation could be due, a minute at most. */
export const holdFor = (pending: Pending, now: number, speech: Speech) =>
  Math.min(
    WAIT_S,
    ...[...pending].map((e) =>
      Math.max(1, Math.ceil((dueAt(e, speech) - now) / 1000))
    )
  );

/**
 * What a watcher starts with: `pending` lives in memory, so the turns first seen in the `REPLAY_S` before the newest
 * are heard again (`hear` finds the asks; `ask` records each once, so a second hearing is harmless).
 */
export function resumed(store: Store, now: number) {
  const pending: Pending = new Map();
  fold(pending, lastSeen(store, REPLAY_S), now);
  return pending;
}

/** Rebuilds the lifelog units and the index holding the lock; false, nothing done, when another run holds it. */
async function syncUnits(store: Store, cursor: string) {
  const n = await locked(async () => {
    const built = await syncLifelogUnits(store);
    await reindex();
    return built;
  });
  if (n) {
    console.log(
      `${clock().toISOString()} cursor ${cursor}: ${n.added} built, ${n.changed} updated, ${n.removed} removed`
    );
  }
  return n !== null;
}

/** Whether Life can act from here, in life-watch.log at start (the connector's `reminders` acts from this process). */
function sayActions() {
  checks().then((problems) =>
    console.log(
      `${clock().toISOString()} actions: ${isOn("actions") ? problems.join("; ") || "ready" : "off"}`
    )
  );
}

export async function watch(): Promise<number> {
  // The code it runs, read before it may wait for another install: new code meanwhile restarts it on taking over.
  const running = codeAt(ROOT);
  await hold("watch");
  const started = clock();
  try {
    serve();
  } catch (e) {
    // The watcher matters more than its server: it keeps polling and says why the server is off.
    console.error("Life's server is off:", (e as Error).message);
  }
  sayActions();
  // Beside the loop, so a slow probe never holds up hearing; the process exits on new code all the same.
  setInterval(
    () =>
      healTunnel().catch((e: Error) =>
        log("run.error", { error: e.message, step: "watch.tunnel" })
      ),
    TUNNEL_EVERY_MS
  );
  if (!listening()) {
    return quiet(running);
  }
  const store = openStore();
  const pending = resumed(store, clock().getTime());
  const speech: Speech = (conversation, from) =>
    speechIn(store, conversation, from);
  let health = readHealth();
  // Units follow the store even if the last run stopped between the two.
  let dirty = true;
  // The first poll answers at once, so health and units are fresh at start; later ones hold for news.
  let more = true;
  // A commit changed apps/server/src/ or prompts/: exit, launchd starts the new code (old code lost a request on 15 Oct by reading a renamed prompt).
  while (codeAt(ROOT) === running) {
    let result: { cursor: string } | { error: string };
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the poll loop is sequential
      const page = await poll(
        store,
        more ? 0 : holdFor(pending, clock().getTime(), speech)
      );
      ({ more } = page);
      dirty ||= page.changed;
      for (const h of hearings(
        pending,
        page.owner,
        clock().getTime(),
        speech
      )) {
        // Heard again after the next wait: words not fetched (never read as silence), or a wake still waiting for
        // its speaker. `again` is the tries it carries, null when done or lost.
        // biome-ignore lint/performance/noAwaitInLoops: one conversation at a time
        const again = await hear(store, h.conversation, h.from).then(
          ({ heard, marked }) => {
            // Its "hey Life" marks changed: the units on disk carry them at the next sync.
            dirty ||= marked;
            return heard ? null : h.tries;
          },
          (e: Error) => {
            const lost = h.tries + 1 >= TRIES;
            log("run.error", { error: e.message, lost, step: "watch.hear" });
            return lost ? null : h.tries + 1;
          }
        );
        if (again !== null) {
          fold(
            pending,
            [{ at: h.from, conversation: h.conversation }],
            clock().getTime(),
            again
          );
        }
      }
      await minute();
      // The nightly rewrites the same unit files and index: while it holds the lock (`isLocked` spares the log a line
      // each poll), `dirty` keeps the sync due.
      if (dirty && !more && !isLocked()) {
        dirty = !(await syncUnits(store, page.cursor));
      }
      result = { cursor: page.cursor };
    } catch (e) {
      result = { error: (e as Error).message };
      console.error(clock().toISOString(), result.error);
    }
    health = afterPoll(health, clock(), result, started);
    if ("error" in result && health.consecutiveErrors === 1) {
      log("run.error", { error: result.error, step: "watch" });
    }
    await Bun.write(HEALTH, `${JSON.stringify(health, null, 2)}\n`);
    if ("error" in result) {
      await Bun.sleep(RETRY_MS);
    }
  }
  console.log(`${clock().toISOString()} new code: restarting`);
  return 0;
}

/** No voice source: nothing to hear or fold, but asks still go out and the tasks' minute still runs. */
async function quiet(running: string) {
  console.log(
    `${clock().toISOString()} watcher: no voice source, not listening`
  );
  while (codeAt(ROOT) === running) {
    // biome-ignore lint/performance/noAwaitInLoops: one pass a minute
    await minute();
    await Bun.sleep(RETRY_MS);
  }
  return 0;
}

/** What runs on every pass, heard or not: delivery first (a slow Reminders host holds up the board, never an ask), then the tasks' minute. */
async function minute() {
  await deliver().catch((e: Error) =>
    log("run.error", { error: e.message, step: "events.deliver" })
  );
  tick().catch((e: Error) =>
    log("run.error", { error: e.message, step: "tasks.tick" })
  );
}

/** `status`: what the watcher says about itself. Non-zero when it is not polling. */
export function status(): number {
  if (!listening()) {
    console.log("watcher: no voice source, not listening");
    return 0;
  }
  const h = readHealth();
  if (!h) {
    console.log("watcher: never ran (no derived/watch/health.json)");
    return 1;
  }
  const ago = (iso: string | null) =>
    iso
      ? `${Math.round((clock().getTime() - new Date(iso).getTime()) / 1000)}s ago`
      : "never";
  const healthy = polling(h);
  console.log(
    [
      `watcher: ${healthy ? "ok" : "NOT POLLING"}`,
      `last poll ${ago(h.lastPollAt)}, last ok ${ago(h.lastOkAt)}`,
      `cursor ${h.cursor}, lag ${h.lagSec}s, consecutive errors ${h.consecutiveErrors}`,
      ...(h.lastError ? [`last error: ${h.lastError}`] : []),
    ].join("\n")
  );
  return healthy ? 0 : 1;
}
