import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { archiveFailing, keptStores } from "./archive";
import { backupOld, backupOn, backupSize, readBackup } from "./backup";
import { clock } from "./clock";
import { agentLive, clientName, deliveryState, isAgent } from "./events";
import { readHealth } from "./health";
import type { Call } from "./log";
import { type LogEvent, recentEvents } from "./log";
import { macState, sleeps } from "./mac";
import { changeFeed } from "./memory/feed";
import { lifeStatus, runs, type Use, useText } from "./memory/history";
import {
  ACTIONS,
  CORRECTIONS,
  linesOf,
  OBSERVATIONS,
  PAGES,
  readActions,
  readRatings,
  readStatements,
  tasksOf,
} from "./memory/ledger";
import { reportKey } from "./memory/report";
import { clip } from "./memory/units";
import { git } from "./proc";
import { checks, remindersOn } from "./reminders/remctl";
import { isBookkeeping, REMINDER_KINDS } from "./schema";
import { agentName, settings } from "./settings";
import { readContacts } from "./sources/contacts";
import {
  type Descriptor,
  enabledSources,
  listening,
  type Newest,
} from "./sources/index";
import { lifelogStatus, newestTurn } from "./sources/lifelog";
import { escalation, taskList } from "./tasks";
import { DATA, loadTruth } from "./truth";

// The status page's plate (`src/dashboard.ts` serves it): every part of Life as a card in a group, each with its state
// now, read from Life's own records and stores, nothing written. A card's colour is `toneOf`'s rule: red only when Life
// can't read or run a part, grey when it is just quiet, amber when quiet past its source's `silentAfter`. His words and
// any error's text live only in `content` (a card's) and `detail` (a tick's): the page hides them in privacy mode, and
// `strip` keeps only the rest when the plate leaves the Mac.

export type Tone = "bad" | "busy" | "idle" | "ok" | "teal" | "warn";

/** One line of a card: a value, or an instant the page shows as "3 min ago". Never his words, never an error's text. */
export interface Fact {
  at?: string | null;
  label: string;
  value?: string;
}

export interface Card {
  /** A sentence to paste into a Claude session, when the part is in trouble. */
  ask?: string;
  /** When its headline happened: the page adds "3 h ago". */
  at?: string | null;
  /** A running process's beat, in ms: the card pulses on it. */
  beat?: number;
  /** His words and errors' text on the card: hidden in privacy mode, never pushed. */
  content?: string[];
  facts: Fact[];
  /** Counts that grow when this part moves data: the page runs dots along its edge when one grows. */
  flow?: number;
  group: string;
  headline: string;
  id: string;
  /** The Pendant is recording now: the card's waveform plays. */
  listening?: boolean;
  name: string;
  /** A running sweep's stations and where it is. */
  stations?: { name: string; state: "done" | "now" | "todo" }[];
  tone: Tone;
  word: string;
}

export interface Tick {
  at: string;
  /** An error's text: hidden in privacy mode, never pushed. */
  detail?: string;
  end?: string;
  label: string;
  tone: Tone;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Received within this, a source reads as live. */
const LIVE_MS = HOUR;

/** A source's tone: unreadable is red; then live, quiet, or silent past its limit. */
export function toneOf(
  at: string | null | undefined,
  limit: number,
  now: number,
  readable = true
): { tone: Tone; word: string } {
  if (!readable) {
    return { tone: "bad", word: "unreadable" };
  }
  if (!at) {
    return { tone: "idle", word: "nothing yet" };
  }
  const quiet = now - Date.parse(at);
  if (quiet < LIVE_MS) {
    return { tone: "ok", word: "receiving" };
  }
  return quiet < limit
    ? { tone: "idle", word: "quiet" }
    : { tone: "warn", word: "silent" };
}

/** Waking hours, when the Pendant is expected to hear him: 08:00 to 01:00 on the Mac's clock (AGENTS.md). */
export const waking = (d: Date) => d.getHours() >= 8 || d.getHours() < 1;

/** When the waking hours `d` falls in began (08:00, the day before after midnight); null outside them. */
export function wokeAt(d: Date) {
  if (!waking(d)) {
    return null;
  }
  const w = new Date(d);
  w.setHours(8, 0, 0, 0);
  if (d.getHours() < 1) {
    w.setDate(w.getDate() - 1);
  }
  return w;
}

/** A run's outcome as a colour: the plate, its details and the page use this one. */
const RUN_TONES: Record<string, Tone> = {
  ok: "ok",
  running: "busy",
  unfinished: "warn",
};
export const toneOfRun = (outcome: string): Tone => RUN_TONES[outcome] ?? "bad";

// --- reads: each redone at most every `ms` (the stream asks every few seconds, the push every minute) ---------------

const memo = new Map<string, { at: number; value: Promise<unknown> }>();
export function cached<T>(key: string, ms: number, read: () => Promise<T> | T) {
  const now = performance.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < ms) {
    return hit.value as Promise<T>;
  }
  const value = Promise.resolve().then(read);
  memo.set(key, { at: now, value });
  return value;
}

/** A read that may fail: its error, never a throw (one broken store never blanks the page). */
async function safe<T>(read: () => Promise<T> | T) {
  try {
    return { ok: true as const, value: await read() };
  } catch (e) {
    return { error: (e as Error).message, ok: false as const };
  }
}

const countLines = (path: string) =>
  existsSync(path) ? linesOf(path).length : 0;
const filesIn = (dir: string, ext: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)) : [];

/** The truth benchmark: statements he rated, and those left. */
async function rated() {
  const [statements, ratings] = await Promise.all([
    readStatements(),
    readRatings(),
  ]);
  const left = statements.filter((s) => !ratings.get(s.claim)).length;
  return {
    left,
    ratings: statements.length - left,
    statements: statements.length,
  };
}

async function memoryCounts() {
  const [at] = git(DATA, ["log", "-1", "--format=%cI"])
    .stdout.toString()
    .trim()
    .split("\n");
  return {
    commitAt: at ? new Date(at).toISOString() : null,
    corrections: countLines(CORRECTIONS),
    moments: filesIn(join(DATA, "memory", "moments"), ".jsonl").length,
    observations: filesIn(OBSERVATIONS, ".jsonl").reduce(
      (n, m) => n + countLines(join(OBSERVATIONS, m)),
      0
    ),
    pages:
      filesIn(join(PAGES, "people"), ".md").length +
      filesIn(join(PAGES, "areas"), ".md").length,
    ...(await rated()),
  };
}

/** His corrections not yet reflected in the index and the pages (`changes`' `reflected: false`), 20 pages at most. */
async function unreflected() {
  let cursor: string | undefined;
  let open = 0;
  for (let i = 0; i < 20; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pages follow one another
    const page = await changeFeed({
      cursor,
      limit: 500,
      types: ["correction"],
    });
    open += page.items.filter(
      (it) => (it as { reflected?: boolean | null }).reflected === false
    ).length;
    cursor = page.cursor ?? undefined;
    if (!cursor || page.remaining === 0) {
      break;
    }
  }
  return open;
}

/** truth/: when he last edited it, and whether the code accepts it. */
async function truthState() {
  const dir = join(DATA, "truth");
  const newest = (d: string): number =>
    readdirSync(d, { withFileTypes: true }).reduce((m, e) => {
      const p = join(d, e.name);
      return Math.max(m, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
    }, 0);
  const loaded = await safe(loadTruth);
  return {
    editedAt: existsSync(dir) ? new Date(newest(dir)).toISOString() : null,
    error: loaded.ok ? null : loaded.error,
    people: loaded.ok ? loaded.value.people.length : 0,
    projects: loaded.ok ? loaded.value.projects.length : 0,
  };
}

export type Line = LogEvent & Record<string, unknown>;
const since = (list: Line[], ms: number, now: number) =>
  list.filter((e) => now - Date.parse(e.at) < ms);

// --- the plate ------------------------------------------------------------------------------------------------------

export const GROUPS = [
  { id: "sources", name: "Sources" },
  { id: "capture", name: "Capture" },
  { id: "pipeline", name: "Pipeline" },
  { id: "memory", name: "Memory" },
  { id: "outputs", name: "Outputs" },
  { id: "mac", name: "The Mac" },
] as const;

/** The plate's edges, between groups, in data's direction. */
export const EDGES = [
  ["sources", "capture"],
  ["capture", "pipeline"],
  ["pipeline", "memory"],
  ["memory", "outputs"],
] as const;

/** A run that recorded any use: runs from before 21 Oct have no tokens and no readings. */
export const spent = (u: Use | null | undefined) =>
  !!u && (u.tokens.input > 0 || !!u.quota?.before || !!u.quota?.after);

const ASK = (what: string) => `Life's status page shows ${what}: look into it.`;

/** The first state whose condition holds: a card's tone and word (and its ask) by precedence. */
const firstOf = (
  ...rules: [boolean | undefined, Pick<Card, "ask" | "tone" | "word">][]
) =>
  rules.find(([holds]) => holds)?.[1] ?? {
    tone: "idle" as Tone,
    word: "unknown",
  };

/** Every source's newest item (`Descriptor.newest`), each read by its own module. */
const newestOf = async () =>
  new Map(
    await Promise.all(
      enabledSources().map(
        async (d) =>
          [
            d.name,
            await cached(
              `newest:${d.name}`,
              d.kind === "repo" ? 5 * MIN : 3000,
              () =>
                safe(
                  async (): Promise<Newest> =>
                    (await d.newest?.()) ?? { at: null }
                )
            ),
          ] as const
      )
    )
  );

/** Every read the plate is made of, each cached for as long as it may lag. */
async function reads(now: Date) {
  const t = now.getTime();
  const [
    status,
    log,
    failing,
    turn,
    life,
    mac,
    mem,
    open,
    truth,
    contacts,
    sleepList,
    swept,
    actions,
    remctl,
    newest,
  ] = await Promise.all([
    cached("status", 5000, () => lifeStatus(now)),
    cached("log", 5000, () => recentEvents<Line>(8, "")),
    cached("failing", 15_000, () => archiveFailing()),
    cached("turn", 3000, () => safe(newestTurn)),
    cached("lifelog", 30_000, () => safe(lifelogStatus)),
    cached("mac", 15_000, () => macState()),
    cached("mem", 60_000, () => memoryCounts()),
    cached("unreflected", 5 * MIN, () => safe(unreflected)),
    cached("truth", 60_000, () => truthState()),
    cached("contacts", 10 * MIN, () => safe(() => readContacts().size)),
    safe(() => cached("sleeps", 5 * MIN, () => sleeps(t))),
    cached("sweeps", 15_000, () =>
      runs({
        limit: 30,
        steps: [
          "memory.nightly",
          "memory.midday",
          "memory.backfill",
          "eval",
          "bench.atlas",
        ],
      })
    ),
    cached("actions", 15_000, readActions),
    cached("remctl", 60_000, checks),
    newestOf(),
  ]);
  const of = (kind: string, days: number) =>
    since(
      log.filter((e) => e.kind === kind),
      days * DAY,
      t
    );
  const mcp = of("mcp.call", 2);
  return {
    actions,
    agentLive: await agentLive(t, async () => mcp as Call[]),
    contacts,
    errorsToday: of("run.error", 1),
    failingStores: new Map(failing),
    health: readHealth(),
    life,
    mac,
    mcp,
    mem,
    models: of("model.run", 1),
    newest,
    now,
    open,
    quotas: of("quota.read", 8),
    remctl,
    sent: of("email.sent", 2),
    sleepList,
    status,
    swept,
    t,
    truth,
    turn,
    writes: of("calendar.write", 2),
  };
}

type Reads = Awaited<ReturnType<typeof reads>>;
const serviceOf = (r: Reads, name: string) =>
  r.mac.services.find((s) => s.name === name);
const polling = (r: Reads) => r.status.watcher.state === "ok";

/** How quiet the Pendant is: silence counts from the start of his waking hours at the earliest (a night is not silence). */
function pendantQuiet(r: Reads, d: Descriptor, spokeAt: string | null) {
  const woke = wokeAt(r.now)?.toISOString();
  const quietSince = spokeAt && woke && woke > spokeAt ? woke : spokeAt;
  const limit = woke ? d.silentAfter : Number.POSITIVE_INFINITY;
  return toneOf(quietSince, limit, r.t, r.turn.ok);
}

type Pendant = NonNullable<
  Extract<Reads["life"], { ok: true }>["value"]["pendant"]
>;

const pendantFacts = (
  p: Pendant | null | undefined,
  spokeAt: string | null
): Fact[] => [
  {
    at: p?.recordingKnownAt,
    // lifelog's phone reports each change as it happens: the state stands since then.
    label: "Recording state, since",
    value: p?.recording ?? "unknown",
  },
  {
    label: "Battery",
    value: typeof p?.batteryPercent === "number" ? `${p.batteryPercent}%` : "?",
  },
  { label: "Connection", value: p?.connection ?? "?" },
  { at: spokeAt, label: "Newest speech heard" },
];

/** The Pendant, as lifelog last heard from the phone, and the newest speech the watcher folded in. */
function pendantCard(r: Reads, d: Descriptor): Card {
  const pendant = r.life.ok ? r.life.value.pendant : undefined;
  const recording = pendant?.recording === "recording";
  const spokeAt = r.turn.ok ? (r.turn.value ?? null) : null;
  const quiet = pendantQuiet(r, d, spokeAt);
  return {
    ...firstOf(
      [recording && quiet.tone === "warn", { tone: "warn", word: "silent" }],
      [recording, { tone: "ok", word: "recording" }],
      [true, quiet]
    ),
    facts: pendantFacts(pendant, spokeAt),
    group: "sources",
    headline: pendant?.recording ?? "unknown",
    id: "pendant",
    listening: recording && !!spokeAt && r.t - Date.parse(spokeAt) < 15 * MIN,
    name: d.label,
  };
}

function lifelogCard(r: Reads): Card {
  const retrying = (r.health?.consecutiveErrors ?? 0) > 0;
  const backlog = r.life.ok
    ? r.life.value.phoneHeartbeat?.backlog?.pages
    : undefined;
  return {
    ...firstOf(
      [
        !polling(r),
        {
          ask: ASK("that the watcher has not polled lifelog for 15 minutes"),
          tone: "bad",
          word: "not polling",
        },
      ],
      [retrying, { tone: "warn", word: "retrying" }],
      [true, { tone: "ok", word: "polling" }]
    ),
    content: r.health?.lastError ? [`Error: ${r.health.lastError}`] : undefined,
    facts: [
      { at: r.health?.lastOkAt, label: "Last good poll" },
      { label: "Lag", value: `${r.health?.lagSec ?? "?"} s` },
      { label: "Cursor", value: r.health?.cursor ?? "?" },
      {
        label: "Retries today",
        value: String(r.errorsToday.filter((e) => e.step === "watch").length),
      },
      {
        label: "Phone backlog",
        value: r.life.ok ? `${backlog ?? "?"} pages` : "unreachable",
      },
    ],
    flow: Number(r.health?.cursor ?? 0),
    group: "sources",
    headline: r.health?.lastOkAt ? "polling" : "never polled",
    id: "lifelog",
    name: "lifelog server",
  };
}

/** A source read from its own store (`Descriptor.newest`): its newest item, its last copy, its failure. */
function sourceCard(r: Reads, d: Descriptor): Card {
  const read = r.newest.get(d.name) ?? {
    error: "not read",
    ok: false as const,
  };
  const n: Newest = read.ok ? read.value : { at: null };
  const broken = r.failingStores.get(d.name);
  // The archive's stores: when it last copied one in (lifeStatus).
  const copiedAt = r.status.capture.archive[d.name];
  const tone = toneOf(n.at, d.silentAfter, r.t, read.ok && !broken);
  const why = broken?.error ?? (read.ok ? undefined : read.error);
  return {
    ...tone,
    ...(tone.tone === "bad"
      ? { ask: ASK(`that ${d.label} cannot be read`) }
      : {}),
    content: [
      ...(n.words ?? []).map((w) => clip(w, 140)),
      ...(why ? [`Error: ${clip(String(why), 300)}`] : []),
    ],
    facts: [
      { at: n.at, label: n.parts?.length ? "Newest" : "Last item" },
      ...(n.parts ?? []).map((p) => ({ at: p.at, label: p.label })),
      ...(copiedAt === undefined
        ? []
        : [{ at: copiedAt, label: "Last copied" }]),
      ...(n.facts ?? []),
      ...(broken ? [{ at: broken.at, label: "Failing since" }] : []),
    ],
    flow: copiedAt ? Date.parse(copiedAt) : undefined,
    group: "sources",
    headline: tone.word,
    id: d.name,
    name: d.label,
  };
}

/** A source he turned on that can't be read now (not set up, or its access gone): what it needs. Its units are kept. */
const unreadableCard = (d: Descriptor, why: string): Card => ({
  facts: [],
  group: "sources",
  headline: why,
  id: d.name,
  name: d.label,
  tone: "bad",
  word: "can't read",
});

function sourceCards(r: Reads): Card[] {
  return [
    ...enabledSources().flatMap((d) => {
      const why = d.missing?.();
      if (why) {
        return [unreadableCard(d, why)];
      }
      return d.kind === "voice"
        ? [pendantCard(r, d), lifelogCard(r)]
        : [sourceCard(r, d)];
    }),
    {
      ...(r.contacts.ok
        ? { tone: "ok", word: "readable" }
        : { tone: "bad", word: "unreadable" }),
      content: r.contacts.ok ? undefined : [`Error: ${r.contacts.error}`],
      facts: [
        {
          label: "Names known",
          value: r.contacts.ok ? String(r.contacts.value) : "?",
        },
      ],
      group: "sources",
      headline: r.contacts.ok ? "readable" : "unreadable",
      id: "contacts",
      name: "Contacts",
    },
  ];
}

function captureCards(r: Reads): Card[] {
  const archiveUp = serviceOf(r, "archive")?.running;
  const watching = serviceOf(r, "watch")?.running;
  const tunnel = serviceOf(r, "cloudflared");
  const calls = since(r.mcp, DAY, r.t);
  const asksToday = r.actions.filter(
    (a) => a.kind === "ask" && r.t - Date.parse(a.at) < DAY
  ).length;
  return [
    {
      ...firstOf(
        [
          !archiveUp,
          {
            ask: ASK("that the archive is not running"),
            tone: "bad",
            word: "stopped",
          },
        ],
        [
          r.failingStores.size > 0,
          {
            ask: ASK(
              `the archive failing on ${[...r.failingStores.keys()].join(", ")}`
            ),
            tone: "bad",
            word: "store failing",
          },
        ],
        [true, { tone: "ok", word: "copying" }]
      ),
      beat: 5000,
      // Each store: copying or failing, and its last copy (lifeStatus's).
      facts: keptStores().map((s) => ({
        at: r.status.capture.archive[s.name],
        label: s.name,
        value: r.failingStores.has(s.name) ? "failing, last copy" : "last copy",
      })),
      group: "capture",
      headline: archiveUp
        ? `every 5 s · ${keptStores().length} stores`
        : "stopped",
      id: "archive",
      name: "Archive",
    },
    {
      ...firstOf(
        [!listening(), { tone: "idle", word: "no voice source" }],
        [
          !watching,
          {
            ask: ASK("that the watcher is not running"),
            tone: "bad",
            word: "stopped",
          },
        ],
        [
          !polling(r),
          {
            ask: ASK("that the watcher is running but not polling"),
            tone: "bad",
            word: "not polling",
          },
        ],
        [true, { tone: "ok", word: "hearing" }]
      ),
      beat: 2000,
      facts: [
        { at: r.health?.lastPollAt, label: "Last poll" },
        { label: "Asks heard today", value: String(asksToday) },
      ],
      flow: Number(r.health?.cursor ?? 0),
      group: "capture",
      headline: polling(r) ? "hearing" : "not polling",
      id: "watcher",
      name: "Watcher",
    },
    {
      facts: [
        { label: "Calls today", value: String(calls.length) },
        { at: calls.at(-1)?.at, label: "Last call" },
        {
          label: "Refused today",
          value: String(calls.filter((c) => c.error || c.refused).length),
        },
      ],
      flow: r.mcp.length,
      group: "capture",
      headline: `${calls.length} calls today`,
      id: "connector",
      name: "Connector",
      tone: "ok",
      word: "serving",
    },
    {
      ...(tunnel?.running
        ? { tone: "ok", word: "up" }
        : {
            ask: ASK("that cloudflared is not running"),
            tone: "bad",
            word: "down",
          }),
      facts: [
        {
          label: "cloudflared",
          value: tunnel?.running ? "running" : (tunnel?.status ?? "?"),
        },
        // The watcher heals the tunnel by restarting cloudflared (tunnel.ts): its start is the last heal or reboot.
        { at: tunnel?.since, label: "Up since" },
      ],
      group: "capture",
      headline: tunnel?.running ? "connected" : "down",
      id: "tunnel",
      name: "Tunnel",
    },
  ];
}

interface Processing {
  phase?: string | null;
  since?: string;
  state: string;
  sweep?: string | null;
}
type Sweep =
  | Reads["status"]["nightly"]
  | Reads["status"]["midday"]
  | Omit<Reads["status"]["backfill"], "state">;

/** A nightly report's email (`reportKey`), by its key. */
const isReport = (key: unknown) => String(key ?? "").startsWith(reportKey(""));

/**
 * A sweep's stations: the phases its last good run went through (its steps among them) and any its latest added,
 * done as its latest went through them, the one it is in now, the one it failed at left to do; for the night, then
 * its report, done once that email went.
 */
export function stationsOf(
  s: Pick<Sweep, "lastOk" | "latest">,
  running: boolean,
  reported: boolean | null
) {
  const latest = s.latest?.phases ?? [];
  const names = [...new Set([...(s.lastOk?.phases ?? []), ...latest])];
  const now = running ? latest.at(-1) : undefined;
  const failedAt =
    s.latest?.outcome === "failed"
      ? String(s.latest.result?.failedAt)
      : undefined;
  const stateOf = (name: string): "done" | "now" | "todo" => {
    if (name === now) {
      return "now";
    }
    return latest.includes(name) && name !== failedAt ? "done" : "todo";
  };
  const stations = names.map((name) => ({ name, state: stateOf(name) }));
  return reported === null
    ? stations
    : [
        ...stations,
        {
          name: "email",
          state: reported ? ("done" as const) : ("todo" as const),
        },
      ];
}

const sweepFacts = (
  s: Sweep,
  next?: { earliest: string; why: string }
): Fact[] => [
  { at: s.lastOk?.endedAt, label: "Last ok" },
  { at: s.lastFailed?.endedAt, label: "Last failed" },
  ...(next ? [{ at: next.earliest, label: `Next (${next.why})` }] : []),
  ...(spent(s.latest?.use)
    ? [{ label: "Last run used", value: useText(s.latest?.use ?? null) }]
    : []),
];

/** A sweep: its last run, its stations, what it spent, and when it runs next. */
function sweepCard(
  r: Reads,
  id: string,
  name: string,
  s: Sweep,
  next?: { earliest: string; why: string }
): Card {
  const proc = r.status.processing as Processing;
  const running =
    proc.state === "running" && !!proc.sweep?.startsWith(`memory.${id}/`);
  const { latest } = s;
  const headline = firstOf(
    [running, { tone: "busy", word: "running since" }],
    [!!latest?.endedAt, { tone: "ok", word: "ran" }],
    [true, { tone: "idle", word: "idle" }]
  ).word;
  return {
    ...firstOf(
      [
        running,
        { tone: "busy", word: proc.phase?.replace("memory.", "") ?? "running" },
      ],
      [
        latest?.outcome === "failed",
        {
          ask: ASK(
            `the ${name.toLowerCase()} run of ${latest?.startedAt} failing`
          ),
          tone: "bad",
          word: "failed",
        },
      ],
      [!!latest, { tone: "ok", word: "ok" }],
      [true, { tone: "idle", word: "none in 7 days" }]
    ),
    at: running ? proc.since : latest?.endedAt,
    content:
      latest?.outcome === "failed"
        ? [`Failed at ${String(latest.result?.failedAt ?? "?")}`]
        : undefined,
    facts: sweepFacts(s, next),
    group: "pipeline",
    headline,
    id,
    name,
    stations:
      running || latest
        ? stationsOf(
            s,
            running,
            id === "nightly"
              ? r.sent.some(
                  (e) => e.key === reportKey(latest?.id.split("/")[1] ?? "")
                )
              : null
          )
        : undefined,
  };
}

function backupCard(r: Reads): Card {
  const b = readBackup();
  const old = backupOld(r.now, b);
  return {
    ...firstOf(
      [!backupOn(), { tone: "idle", word: "off" }],
      [
        !!b?.error,
        { ask: ASK("the backup failing"), tone: "bad", word: "failed" },
      ],
      [old, { tone: "warn", word: "old" }],
      [true, { tone: "ok", word: "ok" }]
    ),
    at: b?.okAt,
    content: b?.error ? [`Error: ${b.error}`] : undefined,
    facts: [
      { at: b?.okAt, label: "Last snapshot" },
      { label: "Size", value: backupSize(b) },
    ],
    group: "pipeline",
    headline: old ? "over 48 h old, last" : "snapshot kept",
    id: "backup",
    name: "Backup",
  };
}

function engineCard(r: Reads): Card {
  const q = r.quotas.findLast((x) => typeof x.used === "number") as
    | { resetsAt?: string; used: number }
    | undefined;
  const week = r.swept.items.filter(
    (x) => spent(x.use) && r.t - Date.parse(x.startedAt ?? "") < 7 * DAY
  );
  const tokens = week.reduce(
    (n, x) => n + (x.use?.tokens.input ?? 0) + (x.use?.tokens.output ?? 0),
    0
  );
  const thinking =
    (r.status.processing as Processing).state === "running" ||
    since(r.models, 2 * MIN, r.t).length > 0;
  return {
    ...firstOf(
      [!q, { tone: "idle", word: "unread" }],
      [(q?.used ?? 0) > 75, { tone: "warn", word: "over reserve" }],
      [thinking, { tone: "busy", word: "thinking" }],
      [true, { tone: "ok", word: "spare" }]
    ),
    facts: [
      { label: "Quota used", value: q ? `${q.used}%` : "not read" },
      { at: q?.resetsAt, label: "Resets" },
      {
        label: "Tokens this week (recorded runs)",
        value: `${Math.round(tokens / 1e3)}k`,
      },
      ...week.slice(0, 6).map((x) => ({
        label: `${x.step.replace("memory.", "")} ${x.startedAt?.slice(5, 16).replace("T", " ")}`,
        value: useText(x.use ?? null),
      })),
    ],
    group: "pipeline",
    headline: q ? `${q.used}% of the week` : "quota not read",
    id: "engine",
    name: "Engine · Codex",
  };
}

function pipelineCards(r: Reads): Card[] {
  const n = r.writes.length;
  return [
    sweepCard(r, "nightly", "Nightly", r.status.nightly, r.status.nightly.next),
    sweepCard(r, "midday", "Midday", r.status.midday, r.status.midday.next),
    sweepCard(r, "backfill", "Backfill", r.status.backfill),
    backupCard(r),
    engineCard(r),
    {
      facts: [
        { at: r.writes.at(-1)?.at, label: "Last event written" },
        { label: "Written in 2 days", value: String(n) },
      ],
      flow: n,
      group: "pipeline",
      headline: n ? `${n} events in 2 days` : "nothing written in 2 days",
      id: "past",
      name: "Past calendar",
      tone: n ? "ok" : "idle",
      word: n ? "syncing" : "quiet",
    },
  ];
}

function memoryCards(r: Reads): Card[] {
  const { mem, open, truth } = r;
  const toReflect = open.ok ? open.value : 0;
  return [
    {
      ...(toReflect > 0
        ? { tone: "teal", word: `${toReflect} to reflect` }
        : { tone: "ok", word: "current" }),
      facts: [
        { label: "Observations", value: String(mem.observations) },
        { label: "People and area pages", value: String(mem.pages) },
        { label: "Days of moments", value: String(mem.moments) },
        { label: "Corrections", value: String(mem.corrections) },
        {
          label: "Not yet reflected",
          value: open.ok ? String(open.value) : "?",
        },
        {
          label: "Statements rated",
          value: `${mem.ratings} of ${mem.statements}`,
        },
        { at: mem.commitAt, label: "Last commit" },
      ],
      flow: mem.observations,
      group: "memory",
      headline: `${mem.observations.toLocaleString("en-US")} observations`,
      id: "memory",
      name: "Memory · ~/Life",
    },
    {
      ...(truth.error
        ? {
            ask: ASK("that truth/ no longer validates"),
            tone: "bad",
            word: "refused",
          }
        : { tone: "ok", word: "valid" }),
      content: truth.error ? [`Refused: ${clip(truth.error, 400)}`] : undefined,
      facts: [
        { at: truth.editedAt, label: "Last edited" },
        { label: "People", value: String(truth.people) },
        { label: "Projects", value: String(truth.projects) },
      ],
      group: "memory",
      headline: truth.error ? "the code refuses it" : "accepted",
      id: "truth",
      name: "Truth · your files",
    },
    {
      facts: [{ at: r.status.indexBuiltAt, label: "Built" }],
      group: "memory",
      headline: "search index",
      id: "index",
      name: "Index",
      tone: r.status.indexBuiltAt ? "ok" : "idle",
      word: r.status.indexBuiltAt ? "built" : "none",
    },
  ];
}

function atlasCards(r: Reads): Card[] {
  const events = deliveryState();
  const lines = linesOf(ACTIONS).length;
  const live = r.agentLive;
  const pulls = settings().agent?.transport === "pull";
  const calls = since(r.mcp, DAY, r.t).filter((c) => isAgent(c.agent));
  const tasks = taskList(r.t);
  const needing = tasksOf().filter((x) => escalation(x, r.t)).length;
  return [
    {
      ...(live
        ? { tone: "ok", word: pulls ? "checking in" : "subscribed" }
        : {
            ask: ASK(`that ${agentName()} isn't receiving asks`),
            tone: "bad",
            word: pulls ? "not checking in" : "no subscription",
          }),
      facts: [
        { at: events.subscription?.verifiedAt, label: "Subscription verified" },
        { at: events.subscription?.refreshBefore, label: "Refresh before" },
        { label: "Ledger lines delivered", value: String(events.delivered) },
        {
          label: "Waiting",
          value: String(Math.max(0, lines - events.delivered)),
        },
        { at: calls.at(-1)?.at, label: "Last call" },
      ],
      flow: events.delivered,
      group: "outputs",
      headline: live ? "receiving asks" : "not receiving asks",
      id: "atlas",
      name: agentName(),
    },
    {
      ...firstOf(
        [needing > 0, { tone: "warn", word: `${needing} need you` }],
        [tasks.length > 0, { tone: "busy", word: "working" }],
        [true, { tone: "ok", word: "clear" }]
      ),
      content: tasks
        .slice(0, 8)
        .map((x) => `${x.state} · ${x.title ?? x.quote}`),
      facts: [
        { label: "Open", value: String(tasks.length) },
        { label: "Need you", value: String(needing) },
        ...tasks
          .slice(0, 5)
          .map((x) => ({ label: x.id, value: `${x.state}, ${x.age}` })),
      ],
      group: "outputs",
      headline: `${tasks.length} open`,
      id: "tasks",
      name: `${agentName()} tasks`,
    },
  ];
}

function outputCards(r: Reads): Card[] {
  const calls = since(r.mcp, DAY, r.t);
  const byClient = Map.groupBy(calls, (c) => clientName(c.agent));
  const acts = r.actions.filter(
    (a) =>
      (REMINDER_KINDS as readonly string[]).includes(a.kind) &&
      !isBookkeeping(a) &&
      r.t - Date.parse(a.at) < DAY
  );
  const failed = acts.filter((a) => a.result === "failed").length;
  const mails = since(r.sent, DAY, r.t);
  const portraitOn = !!process.env.LIFE_PORTRAIT_PASSWORD;
  return [
    ...atlasCards(r),
    {
      content: calls
        .slice(-5)
        .map(
          (c) =>
            `${clientName(c.agent)} · ${c.tool}: ${clip(JSON.stringify(c.args ?? {}), 120)}`
        ),
      facts: [...byClient].map(([name, list]) => ({
        label: name,
        value: `${list.length} calls, last ${list.at(-1)?.tool}`,
      })),
      flow: r.mcp.length,
      group: "outputs",
      headline: `${byClient.size} client${byClient.size === 1 ? "" : "s"} today`,
      id: "clients",
      name: "MCP clients",
      tone: byClient.size ? "ok" : "idle",
      word: byClient.size ? "connected" : "quiet",
    },
    {
      ...firstOf(
        [!remindersOn(), { tone: "idle", word: "off" }],
        [
          r.remctl.length > 0,
          {
            ask: ASK("that Life can't reach Reminders"),
            tone: "bad",
            word: "unreachable",
          },
        ],
        [failed > 0, { tone: "warn", word: "a failure" }],
        [true, { tone: "ok", word: "ready" }]
      ),
      content: [
        ...r.remctl,
        ...acts
          .slice(-5)
          .map(
            (a) =>
              `${a.kind} ${String(a.after?.title ?? a.before?.title ?? "")}`
          ),
      ],
      facts: [
        { label: "Actions today", value: String(acts.length) },
        { label: "Failed today", value: String(failed) },
        { at: acts.at(-1)?.at, label: "Last action" },
      ],
      group: "outputs",
      headline: `${acts.length} actions today`,
      id: "reminders",
      name: "Reminders",
    },
    {
      content: mails.map((m) => String(m.subject ?? m.key ?? "")),
      facts: [
        { label: "Sent today", value: String(mails.length) },
        {
          label: "Alerts today",
          value: String(mails.filter((m) => !isReport(m.key)).length),
        },
        {
          at: mails.findLast((m) => isReport(m.key))?.at,
          label: "Last report",
        },
      ],
      flow: r.sent.length,
      group: "outputs",
      headline: `${mails.length} sent today`,
      id: "email",
      name: "Email",
      tone: "ok",
      word: "sending",
    },
    {
      facts: [{ label: "Left to rate", value: String(r.mem.left) }],
      group: "outputs",
      headline: `${r.mem.left} to rate`,
      id: "check",
      name: "/check",
      tone: "ok",
      word: "serving",
    },
    {
      facts: [
        {
          label: "Pages",
          value: String(
            filesIn(join(DATA, "docs", "portrait"), ".html").length
          ),
        },
      ],
      group: "outputs",
      headline: portraitOn ? "behind its password" : "off",
      id: "portrait",
      name: "/me",
      tone: portraitOn ? "ok" : "idle",
      word: portraitOn ? "serving" : "off",
    },
  ];
}

const serviceState = (sv: Reads["mac"]["services"][number]) => {
  if (sv.running) {
    return { headline: "running", state: "running" };
  }
  return sv.ok
    ? { headline: "between ticks", state: "between ticks (every 30 min)" }
    : { headline: "down", state: `not running (${sv.status})` };
};

function macCards(r: Reads): Card[] {
  const down = r.mac.services.filter((s) => !s.ok);
  return [
    {
      ...(down.length
        ? {
            ask: ASK(
              `${down.map((s) => s.name).join(", ")} not running on the Mac`
            ),
            tone: "bad",
            word: `${down.length} down`,
          }
        : { tone: "ok", word: "online" }),
      facts: [
        { at: r.mac.awakeSince, label: "Awake since" },
        { label: "Battery", value: r.mac.battery },
        { label: "Disk free", value: `${r.mac.freeGb} GB` },
      ],
      group: "mac",
      headline: "online",
      id: "mac",
      name: "MacBook",
    },
    ...r.mac.services.map((sv): Card => {
      const { headline, state } = serviceState(sv);
      return {
        ...firstOf(
          [
            !sv.ok,
            {
              ask: ASK(`that the ${sv.name} service is not running on the Mac`),
              tone: "bad",
              word: "down",
            },
          ],
          [sv.running, { tone: "ok", word: "running" }],
          [true, { tone: "idle", word: "waiting" }]
        ),
        facts: [
          { label: "state", value: state },
          { at: sv.since, label: "Up since" },
        ],
        group: "mac",
        headline,
        id: `service-${sv.name.replaceAll(" ", "-")}`,
        name: sv.name,
      };
    }),
  ];
}

/** The last 24 h: runs, failures (the watcher's retries apart), sends and the Mac's sleeps. */
function todayOf(r: Reads): Tick[] {
  return [
    ...r.swept.items
      .filter((x) => x.startedAt && r.t - Date.parse(x.startedAt) < DAY)
      .map((x) => ({
        at: x.startedAt ?? "",
        end: x.endedAt ?? undefined,
        label: `${x.step.replace("memory.", "")} ${x.outcome}`,
        tone: toneOfRun(x.outcome),
      })),
    // The watcher retries lifelog on its own: a timeout is a retry, not a failure.
    ...r.errorsToday.map((e) => ({
      at: e.at,
      detail: clip(String(e.error), 200),
      label: `${e.step} ${e.step === "watch" ? "retried" : "failed"}`,
      tone: (e.step === "watch" ? "warn" : "bad") as Tone,
    })),
    ...since(r.sent, DAY, r.t).map((e) => ({
      at: e.at,
      label: "email sent",
      tone: "teal" as Tone,
    })),
    ...(r.sleepList.ok
      ? r.sleepList.value.map((x) => ({
          ...x,
          label: "Mac asleep",
          tone: "idle" as Tone,
        }))
      : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
}

const RANK: Record<Tone, number> = {
  bad: 3,
  busy: 0,
  idle: 0,
  ok: 0,
  teal: 1,
  warn: 2,
};

/** Everything on the plate now. */
export async function snapshot(now = clock()) {
  const r = await reads(now);
  const cards = [
    ...sourceCards(r),
    ...captureCards(r),
    ...pipelineCards(r),
    ...memoryCards(r),
    ...outputCards(r),
    ...macCards(r),
  ];
  return {
    cards,
    edges: EDGES,
    groups: GROUPS,
    observedAt: now.toISOString(),
    problems: cards.filter((c) => c.tone === "bad" || c.tone === "warn").length,
    today: todayOf(r),
    worst: cards.reduce<Tone>(
      (w, c) => (RANK[c.tone] > RANK[w] ? c.tone : w),
      "ok"
    ),
  };
}

export type Plate = Awaited<ReturnType<typeof snapshot>>;

/** The plate as it may leave the Mac: each card and tick keeps only its listed fields, so none of his words go. */
export const strip = (s: Plate): Plate => ({
  ...s,
  cards: s.cards.map((c) => ({
    at: c.at,
    beat: c.beat,
    facts: c.facts,
    flow: c.flow,
    group: c.group,
    headline: c.headline,
    id: c.id,
    listening: c.listening,
    name: c.name,
    stations: c.stations,
    tone: c.tone,
    word: c.word,
  })),
  today: s.today.map((t) => ({
    at: t.at,
    end: t.end,
    label: t.label,
    tone: t.tone,
  })),
});
