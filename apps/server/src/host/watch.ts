import { clock, DAY, HOUR, MIN } from "../core/clock";
import { appendJsonl } from "../core/files";
import { hold } from "../core/lock";
import { log } from "../core/log";
import { isOn } from "../core/outputs";
import { LIFE_CODE_DIR } from "../core/paths";
import { codeAt } from "../core/proc";
import { LEDGER, readLedger } from "../memory/ledger";
import { isLocked, locked, lockedSince } from "../memory/memory-lock";
import {
  readSearchedTexts,
  readStaleness,
  reindex,
  reindexUnits,
} from "../memory/search";
import { listening } from "../memory/sources";
import { syncLifelogUnits } from "../memory/units";
import { embedderNow, embedNew, pruneVectors } from "../memory/vectors";
import { isOnline } from "../models/llm";
import { LedgerEntry } from "../records/ledger-entry";
import { lastSeen, openStore, poll, type Store } from "../sources/lifelog";
import { checks, pull } from "../todo-list/backend";
import { HEALTH, type Health, polling, readHealth } from "./health";
import { hear, speechIn } from "./hear";
import { serve } from "./http/server";
import { inbound } from "./inbound";
import { lockReport, sendReport } from "./report";

// `bun life watch` (kept running by the app): long-polls lifelog's change feed into the store and, when a page changed
// anything, rewrites the lifelog units from where it touched and their index rows; the whole index when a unit went
// or a code rule dropped or took one back, or what the full rebuild reads changed (not while the nightly holds the lock). Health is in
// derived/watch/health.json (`bun life status`). An outage (the Mac offline, mostly) delays, never loses: the cursor
// is gap-free and speech up to a week old is still heard, so nothing alerts on it (decided 20 Oct).
// It also hears "hey <agent>": once a conversation's speech is complete (`speechIn`, `WAIT_MS`), `hear` records its asks
// (a wake with no speaker waits for one, up to `NAMING_MS`). Each minute, on its own timer, `tick` reads his to-do list: lifelog
// down never stops it (1 Nov: 20 h without one). Every 10 minutes, on another, what search ranks by meaning is embedded.

let ticking = false;
/**
 * Each minute, one at a time, beside the loop (reading his lists takes about 10 s): his changes in his to-do list
 * (apps/server/src/todo-list) recorded as state. `at` is taken before the read: what Life writes during it falls in the
 * lag window.
 */
async function tick() {
  if (ticking || !isOn("todo_list")) {
    return;
  }
  ticking = true;
  try {
    const at = clock().toISOString();
    const read = performance.now();
    const s = await pull();
    log("sync.pull", { ms: Math.round(performance.now() - read) });
    const lines = inbound(s, readLedger(), at);
    if (lines.length > 0) {
      appendJsonl(LEDGER, LedgerEntry, lines);
    }
  } finally {
    ticking = false;
  }
}

let embedding = false;
/** How often the texts search ranks by meaning are embedded: what is new waits at most this for search by meaning. */
const EMBED_EVERY = 10 * MIN;
/** On its own timer, one at a time, beside the loop: the texts search ranks by meaning with no vector yet (`embedNew`). */
async function embedSearched() {
  const embedder = embedderNow();
  if (embedding || !embedder) {
    return;
  }
  embedding = true;
  try {
    const { isWhole, texts } = await readSearchedTexts();
    if (isWhole) {
      pruneVectors(embedder, texts);
    }
    await embedNew(embedder, texts);
  } finally {
    embedding = false;
  }
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
const WAIT_MS = { complete: 5000, open: MIN };
/** A replay of the store (after a restart or an outage) never acts on speech older than a week. */
const RECENT_MS = 7 * DAY;
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

/**
 * What the watcher owes the store: the lifelog units from an instant on (null: none), and the whole index
 * (`isIndexOwed`; otherwise the index follows the units it writes, `reindexUnits`).
 */
interface Owed {
  from: Date | null;
  isIndexOwed: boolean;
}
/** The earlier of two instants the units are owed from. */
const earliest = (a: Date | null, b: Date | null) =>
  a && b && b < a ? b : (a ?? b);

/**
 * Pays what is owed holding the lock, and what the index's staleness adds (`readStaleness`: a correction is
 * searchable within the minute; a `truth/` edit builds every lifelog unit again); returns what is still owed (all of
 * it when another run held the lock). A unit that went, or that a code rule dropped or took back, takes the full
 * `reindex`.
 */
async function settle(store: Store, cursor: string, owed: Owed): Promise<Owed> {
  const stale = readStaleness();
  const due = {
    from: stale === "truth" ? new Date(0) : owed.from,
    isIndexOwed: owed.isIndexOwed || stale !== null,
  };
  if (!(due.from || due.isIndexOwed)) {
    return due;
  }
  const done = await locked(async () => {
    const built = due.from ? await syncLifelogUnits(store, due.from) : null;
    // Written units no longer differ: if the index update throws, the retry owes the whole index.
    owed.isIndexOwed ||= !!(built?.written.length || built?.hasGoneOrBack);
    if (due.isIndexOwed || built?.hasGoneOrBack) {
      await reindex();
    } else if (built?.written.length) {
      await reindexUnits(built.written);
    }
    return { built };
  });
  if (done?.built) {
    const n = done.built;
    console.log(
      `${clock().toISOString()} cursor ${cursor}: ${n.added} built, ${n.changed} updated, ${n.removed} removed`
    );
  }
  return done ? { from: null, isIndexOwed: false } : due;
}

/** Whether Life can act from here, in life-watch.log at start (the connector's `change_todo_item` acts from this process). */
function sayActions() {
  checks().then((problems) =>
    console.log(
      `${clock().toISOString()} actions: ${isOn("todo_list") ? problems.join("; ") || "ready" : "off"}`
    )
  );
}

export async function watch(): Promise<number> {
  // The code it runs, read before it may wait for another install: new code meanwhile restarts it on taking over.
  const running = codeAt(LIFE_CODE_DIR);
  await hold("watch");
  const started = clock();
  try {
    serve();
  } catch (e) {
    // The watcher matters more than its server: it keeps polling and says why the server is off.
    log("run.error", { error: String(e), step: "watch.serve" });
  }
  sayActions();
  minute();
  embedEvery();
  const timers = [
    setInterval(minute, MIN),
    setInterval(embedEvery, EMBED_EVERY),
  ];
  try {
    return await (listening() ? listen(running, started) : quiet(running));
  } finally {
    for (const t of timers) {
      clearInterval(t);
    }
  }
}

async function listen(running: string, started: Date): Promise<number> {
  const store = openStore();
  const pending = resumed(store, clock().getTime());
  const speech: Speech = (conversation, from) =>
    speechIn(store, conversation, from);
  let health = readHealth();
  // At start, every unit follows the store and the index is rebuilt: the last run may have stopped between the two.
  let owed: Owed = { from: new Date(0), isIndexOwed: true };
  // The first poll answers at once, so health and units are fresh at start; later ones hold for news.
  let more = true;
  // A commit changed apps/server/src/ or prompts/: exit, the app starts the new code (old code lost a request on 15 Oct by reading a renamed prompt).
  while (codeAt(LIFE_CODE_DIR) === running) {
    let result: { cursor: string } | { error: string };
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the poll loop is sequential
      const page = await poll(
        store,
        more ? 0 : holdFor(pending, clock().getTime(), speech)
      );
      ({ more } = page);
      owed.from = earliest(owed.from, page.touched);
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
            // Its marks (its asks' spans, on its turns from `from`) changed: the units carry them at the next sync.
            if (marked) {
              owed.from = earliest(owed.from, new Date(h.from));
            }
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
      // The nightly rewrites the same unit files and index: while it holds the lock (`isLocked` spares the log a line
      // each poll), `owed` keeps the sync due.
      if (!(more || isLocked())) {
        owed = await settle(store, page.cursor, owed);
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

/** No voice source: nothing to hear or fold; the to-do minute runs on its timer until new code. */
async function quiet(running: string) {
  console.log(
    `${clock().toISOString()} watcher: no voice source, not listening`
  );
  while (codeAt(LIFE_CODE_DIR) === running) {
    // biome-ignore lint/performance/noAwaitInLoops: waits for new code
    await Bun.sleep(RETRY_MS);
  }
  return 0;
}

function minute() {
  tick().catch((e: Error) =>
    log("run.error", { error: e.message, step: "todo.tick" })
  );
  mailStuckLock().catch((e: Error) =>
    log("run.error", { error: e.message, step: "watch.lock" })
  );
}

const STUCK_MS = 3 * HOUR;
/** A run holding the lock over 3 hours, mailed from here: a hung night blocks every tick that could tell. Online only. */
export async function mailStuckLock() {
  const held = lockedSince();
  if (
    held &&
    clock().getTime() - held.getTime() > STUCK_MS &&
    (await isOnline())
  ) {
    await sendReport(
      `lock/${held.toISOString()}`,
      lockReport(held.toISOString())
    );
  }
}

function embedEvery() {
  embedSearched().catch((e: Error) =>
    log("run.error", { error: e.message, step: "watch.embed" })
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
