import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { archiveFailing, STORES } from "./archive";
import { clock } from "./clock";
import { subscribed } from "./events";
import { readHealth } from "./health";
import { type LogEvent, recentEvents } from "./log";
import { lifeStatus, runs, type Use, useText } from "./memory/history";
import {
  ACTIONS,
  CORRECTIONS,
  linesOf,
  OBSERVATIONS,
  PAGES,
  readActions,
  readJson,
  readRatings,
  readStatements,
} from "./memory/ledger";
import { exec } from "./proc";
import { isBookkeeping, REMINDER_KINDS } from "./schema";
import { archiveDb } from "./sources/archived";
import { readContacts } from "./sources/contacts";
import { fromAppleNs, textFromAttributedBody } from "./sources/imessage";
import { lifelogStatus, WATCH } from "./sources/lifelog";
import { escalation, taskList, tasksOf } from "./tasks";
import { DATA, loadTruth, ROOT } from "./truth";

// The status page's plate (`src/dashboard.ts` serves it): every part of Life as a card in a group, each with its state
// now, read from Life's own records and stores, nothing written. A card's colour is `toneOf`'s rule: red only when Life
// can't read or run a part, grey when it is just quiet, amber when quiet past its limit (`LIMITS`). `content` holds his
// words (message text, quotes, arguments): the page hides it in privacy mode, and `strip` drops it before the snapshot
// leaves the Mac.

export type Tone = "bad" | "busy" | "idle" | "ok" | "teal" | "warn";

/** One line of a card: a value, or an instant the page shows as "3 min ago". */
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
  /** His words on the card (a message's text, an ask's quote): hidden in privacy mode, never pushed. */
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
  end?: string;
  label: string;
  tone: Tone;
}

const WAKE_SEC = /sec = (\d+)/;
const SPACES = /\s+/;
const BATTERY = /(\d+)%;\s*([^;]+)/;
const POWER_LINE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}) (Sleep|Wake)\s/;
const ZONE_OFFSET = / ([+-]\d{2})(\d{2})$/;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long a source may stay silent before its card turns amber; the Pendant only between 08:00 and 01:00. */
export const LIMITS = {
  beeper: 3 * DAY,
  git: 3 * DAY,
  imessage: DAY,
  mail: 12 * HOUR,
  notes: 7 * DAY,
  pendant: 6 * HOUR,
  whatsapp: DAY,
};

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

/** Waking hours, when the Pendant is expected to hear him: 08:00 to 01:00 on the Mac's clock. */
export const waking = (d: Date) => d.getHours() >= 8 || d.getHours() < 1;

// --- caching: a read is redone at most every `ms` (the stream asks every few seconds) -------------------------------

const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ms: number, read: () => Promise<T> | T) {
  const now = performance.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < ms) {
    return hit.value as Promise<T>;
  }
  const value = Promise.resolve()
    .then(read)
    .catch((e: Error) => {
      throw e;
    });
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

function query<T>(path: string, sql: string): T | null {
  const db = new Database(`file:${path}?mode=ro`, { readonly: true });
  try {
    return db.query<T, []>(sql).get();
  } finally {
    db.close();
  }
}

// --- the sources' newest items -------------------------------------------------------------------------------------

interface Latest {
  at: string | null;
  content?: string;
  copiedAt?: string | null;
}

const clip = (s: string | null | undefined, n = 140) => {
  const t = (s ?? "").replaceAll(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const whatsappLatest = (): Latest => {
  const r = query<{
    at: string | null;
    chatName: string | null;
    senderName: string | null;
    text: string;
    seen: string | null;
  }>(
    archiveDb("whatsapp"),
    "select at, chatName, senderName, text, (select max(seenAt) from messages) as seen from messages order by at desc limit 1"
  );
  return {
    at: r?.at ?? null,
    content: r
      ? `${r.chatName ?? "?"}${r.senderName ? ` · ${r.senderName}` : ""}: ${clip(r.text)}`
      : undefined,
    copiedAt: r?.seen ?? null,
  };
};

const beeperLatest = () => {
  const db = new Database(`file:${archiveDb("beeper")}?mode=ro`, {
    readonly: true,
  });
  try {
    return db
      .query<
        {
          at: string;
          chatName: string | null;
          network: string;
          seen: string;
          text: string;
        },
        []
      >(
        "select network, max(at) as at, chatName, text, max(seenAt) as seen from messages group by network order by at desc"
      )
      .all();
  } finally {
    db.close();
  }
};

const notesLatest = (): Latest => {
  const r = query<{ at: string; seen: string; title: string | null }>(
    archiveDb("notes"),
    "select at, title, (select max(seenAt) from versions) as seen from versions order by at desc limit 1"
  );
  return {
    at: r?.at ?? null,
    content: r?.title ? `Note: ${clip(r.title)}` : undefined,
    copiedAt: r?.seen ?? null,
  };
};

const CHAT_DB = join(homedir(), "Library/Messages/chat.db");
const imessageLatest = (): Latest => {
  const r = query<{
    attributedBody: Uint8Array | null;
    date: number | bigint;
    text: string | null;
  }>(
    CHAT_DB,
    "select date, text, attributedBody from message order by date desc limit 1"
  );
  if (!r) {
    return { at: null };
  }
  return {
    at: fromAppleNs(r.date).toISOString(),
    content: clip(r.text || textFromAttributedBody(r.attributedBody)),
  };
};

const ENVELOPE = join(homedir(), "Library/Mail/V10/MailData/Envelope Index");
const mailLatest = (): Latest => {
  const r = query<{
    at: number;
    comment: string | null;
    subject: string | null;
  }>(
    ENVELOPE,
    "select m.date_received as at, s.subject, a.comment from messages m left join subjects s on s.ROWID = m.subject left join addresses a on a.ROWID = m.sender order by m.date_received desc limit 1"
  );
  return r
    ? {
        at: new Date(r.at * 1000).toISOString(),
        content: `${r.comment || "?"}: ${clip(r.subject)}`,
      }
    : { at: null };
};

/** Newest commit in every repo under ~/Work (the folders with a .git), and how many committed in the last day. */
async function gitLatest(now: number) {
  const work = join(homedir(), "Work");
  const repos = readdirSync(work).filter((d) =>
    existsSync(join(work, d, ".git"))
  );
  const times = await Promise.all(
    repos.map(async (r) => {
      const out = await exec(
        ["git", "-C", join(work, r), "log", "-1", "--all", "--format=%cI"],
        { timeout: 10_000 }
      );
      return { at: out.stdout.trim() || null, repo: r };
    })
  );
  const dated = times
    .filter((t) => t.at)
    .sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""));
  return {
    at: dated[0]?.at ? new Date(dated[0].at).toISOString() : null,
    newest: dated[0]?.repo,
    today: dated.filter((t) => now - Date.parse(t.at ?? "") < DAY).length,
  };
}

/** The watch store's newest speech turn (lifelog sends turns once transcribed: minutes after they were spoken). */
const newestTurn = () =>
  query<{ at: string | null; seen: string | null }>(
    join(WATCH, "lifelog.sqlite"),
    "select max(start_at) as at, max(seen_at) as seen from turns"
  );

// --- the Mac --------------------------------------------------------------------------------------------------------

const SERVICES = [
  { label: "com.ericedouard.life.archive", name: "archive" },
  { label: "com.ericedouard.life.watch", name: "watch" },
  { label: "com.ericedouard.life.memory-nightly", name: "nightly tick" },
  { label: "com.eric.cloudflared", name: "cloudflared" },
];

async function macState() {
  const [list, batt, disk, wake] = await Promise.all([
    exec(["launchctl", "list"]),
    exec(["pmset", "-g", "batt"]),
    exec(["df", "-k", "/"]),
    exec(["sysctl", "-n", "kern.waketime"]),
  ]);
  const rows = new Map(
    list.stdout.split("\n").map((l) => {
      const [pid, status, label] = l.split("\t");
      return [label, { pid, status }] as const;
    })
  );
  const sec = Number(wake.stdout.match(WAKE_SEC)?.[1] ?? 0);
  const free =
    Number(disk.stdout.trim().split("\n").at(-1)?.split(SPACES)[3] ?? 0) * 1024;
  return {
    awakeSince: sec ? new Date(sec * 1000).toISOString() : null,
    battery: batt.stdout.match(BATTERY)?.slice(1, 3).join(", ") ?? "?",
    freeGb: Math.round(free / 1e9),
    services: SERVICES.map((s) => {
      const r = rows.get(s.label);
      // KeepAlive jobs run with a pid; the nightly tick runs every 30 min, so no pid with a 0 last exit is fine.
      const running = !!r && r.pid !== "-";
      const ok = running || (r?.status === "0" && s.name === "nightly tick");
      return { name: s.name, ok, running, status: r?.status ?? "not loaded" };
    }),
  };
}

/** The Mac's sleeps of the last day, from the power log. */
async function sleeps(now: number) {
  const out = await exec(["pmset", "-g", "log"], { timeout: 20_000 });
  const since = now - DAY;
  const list: { at: string; end?: string }[] = [];
  for (const line of out.stdout.split("\n")) {
    const m = line.match(POWER_LINE);
    if (!m?.[1]) {
      continue;
    }
    const at = new Date(
      m[1].replace(" ", "T").replace(ZONE_OFFSET, "$1:$2")
    ).getTime();
    if (at < since) {
      continue;
    }
    if (m[2] === "Sleep") {
      list.push({ at: new Date(at).toISOString() });
    } else {
      const open = list.at(-1);
      if (open && !open.end) {
        open.end = new Date(at).toISOString();
      }
    }
  }
  return list;
}

// --- memory ---------------------------------------------------------------------------------------------------------

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
  const months = filesIn(OBSERVATIONS, ".jsonl");
  const commit = await exec([
    "git",
    "-C",
    DATA,
    "log",
    "-1",
    "--format=%cI%x09%s",
  ]);
  const [at, subject] = commit.stdout.trim().split("\t");
  return {
    commitAt: at ? new Date(at).toISOString() : null,
    commitSubject: subject ?? "",
    corrections: countLines(CORRECTIONS),
    moments: filesIn(join(DATA, "memory", "moments"), ".jsonl").length,
    observations: months.reduce(
      (n, m) => n + countLines(join(OBSERVATIONS, m)),
      0
    ),
    pages:
      filesIn(join(PAGES, "people"), ".md").length +
      filesIn(join(PAGES, "areas"), ".md").length,
    ...(await rated()),
  };
}

/** His corrections not yet reflected in the index and the pages (`changes`' `reflected: false`). */
async function unreflected() {
  const { changeFeed } = await import("./memory/feed");
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
  const editedAt = existsSync(dir) ? new Date(newest(dir)).toISOString() : null;
  const loaded = await safe(loadTruth);
  return {
    editedAt,
    error: loaded.ok ? null : loaded.error,
    people: loaded.ok ? loaded.value.people.length : 0,
    projects: loaded.ok ? loaded.value.projects.length : 0,
  };
}

// --- the log --------------------------------------------------------------------------------------------------------

type Line = LogEvent & Record<string, unknown>;
const since = (list: Line[], ms: number, now: number) =>
  list.filter((e) => now - Date.parse(e.at) < ms);

/** MCP clients by user agent: the names he knows them by. */
export const clientName = (agent: unknown) => {
  const a = String(agent ?? "");
  if (a.startsWith("openai-mcp")) {
    return "ChatGPT (Atlas)";
  }
  if (a.toLowerCase().includes("claude")) {
    return "Claude";
  }
  return a || "unknown client";
};

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
const spent = (u: Use | null | undefined) =>
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

/** Every read the plate is made of, each cached for as long as it may lag (the stream asks every few seconds). */
async function reads(now: Date) {
  const t = now.getTime();
  const [
    status,
    events,
    mcp,
    sent,
    quotas,
    models,
    failing,
    turn,
    life,
    wa,
    bp,
    nt,
    im,
    ml,
    gt,
    mac,
    mem,
    open,
    truth,
    contacts,
    sleepList,
    swept,
    writes,
    actions,
  ] = await Promise.all([
    cached("status", 5000, () => lifeStatus(now)),
    cached("events", 5000, () => recentEvents<Line>(2)),
    cached("mcp", 5000, () => recentEvents<Line>(2, "mcp.call")),
    cached("sent", 15_000, () => recentEvents<Line>(2, "email.sent")),
    cached("quota", 15_000, () => recentEvents<Line>(8, "quota.read")),
    cached("models", 5000, () => recentEvents<Line>(1, "model.run")),
    cached("failing", 15_000, () => archiveFailing()),
    cached("turn", 3000, () => safe(newestTurn)),
    cached("lifelog", 30_000, () => safe(lifelogStatus)),
    cached("wa", 3000, () => safe(whatsappLatest)),
    cached("bp", 3000, () => safe(beeperLatest)),
    cached("nt", 5000, () => safe(notesLatest)),
    cached("im", 10_000, () => safe(imessageLatest)),
    cached("ml", 30_000, () => safe(mailLatest)),
    cached("git", 5 * MIN, () => safe(() => gitLatest(t))),
    cached("mac", 15_000, () => macState()),
    cached("mem", 60_000, () => memoryCounts()),
    cached("unreflected", 5 * MIN, () => safe(unreflected)),
    cached("truth", 60_000, () => truthState()),
    cached("contacts", 10 * MIN, () => safe(() => readContacts().size)),
    cached("sleeps", 5 * MIN, () => safe(() => sleeps(t))),
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
    cached("calendar", 15_000, () => recentEvents<Line>(2, "calendar.write")),
    cached("actions", 15_000, readActions),
  ]);
  return {
    actions,
    bp,
    contacts,
    errorsToday: since(events, DAY, t).filter((e) => e.kind === "run.error"),
    failingStores: new Map(failing),
    gt,
    health: readHealth(),
    im,
    life,
    mac,
    mcp,
    mem,
    ml,
    models,
    now,
    nt,
    open,
    quotas,
    sent,
    sleepList,
    status,
    swept,
    t,
    truth,
    turn,
    wa,
    writes,
  };
}

type Reads = Awaited<ReturnType<typeof reads>>;
const serviceOf = (r: Reads, name: string) =>
  r.mac.services.find((s) => s.name === name);
const polling = (r: Reads) => r.status.watcher.state === "ok";

function pendantCard(r: Reads): Card {
  const pendant = r.life.ok
    ? (r.life.value as { pendant?: Record<string, string> }).pendant
    : undefined;
  const recording = pendant?.recording === "recording";
  const spokeAt = r.turn.ok ? (r.turn.value?.at ?? null) : null;
  const quiet = toneOf(
    spokeAt,
    waking(r.now) ? LIMITS.pendant : Number.POSITIVE_INFINITY,
    r.t,
    r.turn.ok
  );
  return {
    ...firstOf(
      [recording && quiet.tone === "warn", { tone: "warn", word: "silent" }],
      [recording, { tone: "ok", word: "recording" }],
      [true, quiet]
    ),
    facts: [
      {
        at: pendant?.recordingKnownAt,
        label: "Recording, as of",
        value: pendant?.recording ?? "unknown",
      },
      {
        label: "Battery",
        value: pendant?.batteryPercent ? `${pendant.batteryPercent}%` : "?",
      },
      { label: "Connection", value: pendant?.connection ?? "?" },
      { at: spokeAt, label: "Newest speech heard" },
    ],
    group: "sources",
    headline: pendant?.recording ?? "unknown",
    id: "pendant",
    listening: recording && !!spokeAt && r.t - Date.parse(spokeAt) < 15 * MIN,
    name: "Pendant",
  };
}

function lifelogCard(r: Reads): Card {
  const retrying = (r.health?.consecutiveErrors ?? 0) > 0;
  const backlog = r.life.ok
    ? (r.life.value as { phoneHeartbeat?: { backlog?: { pages?: number } } })
        .phoneHeartbeat?.backlog?.pages
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
    facts: [
      { at: r.health?.lastOkAt, label: "Last good poll" },
      { label: "Lag", value: `${r.health?.lagSec ?? "?"} s` },
      { label: "Cursor", value: r.health?.cursor ?? "?" },
      {
        label: "Errors today",
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

/** A source read from a store: its last message, its last copy, its failure. */
function storeCard(
  r: Reads,
  id: string,
  name: string,
  read: { ok: true; value: Latest } | { error: string; ok: false },
  limit: number
): Card {
  const broken = r.failingStores.get(id);
  const at = read.ok ? read.value.at : null;
  const tone = toneOf(at, limit, r.t, read.ok && !broken);
  const why = broken?.error ?? (read.ok ? "" : read.error);
  return {
    ...tone,
    ...(tone.tone === "bad"
      ? { ask: ASK(`that ${name} cannot be read: ${why}`) }
      : {}),
    content: read.ok && read.value.content ? [read.value.content] : undefined,
    facts: [
      { at, label: "Last message" },
      ...(read.ok && read.value.copiedAt !== undefined
        ? [{ at: read.value.copiedAt, label: "Last copied" }]
        : []),
      ...(broken ? [{ at: broken.at, label: "Failing since" }] : []),
      ...(read.ok ? [] : [{ label: "Error", value: read.error }]),
    ],
    flow:
      read.ok && read.value.copiedAt
        ? Date.parse(read.value.copiedAt)
        : undefined,
    group: "sources",
    headline: tone.word,
    id,
    name,
  };
}

function beeperCard(r: Reads): Card {
  const networks = r.bp.ok ? r.bp.value : [];
  const tone = toneOf(
    networks[0]?.at ?? null,
    LIMITS.beeper,
    r.t,
    r.bp.ok && !r.failingStores.get("beeper")
  );
  return {
    ...tone,
    content: networks.length
      ? networks.map(
          (n) => `${n.network}: ${n.chatName ?? "?"}: ${clip(n.text, 80)}`
        )
      : undefined,
    facts: [
      ...networks.map((n) => ({ at: n.at, label: n.network })),
      ...(r.bp.ok ? [] : [{ label: "Error", value: r.bp.error }]),
    ],
    flow: networks.reduce((m, n) => Math.max(m, Date.parse(n.seen)), 0),
    group: "sources",
    headline: tone.word,
    id: "beeper",
    name: "Beeper",
  };
}

function sourceCards(r: Reads): Card[] {
  const git = toneOf(r.gt.ok ? r.gt.value.at : null, LIMITS.git, r.t, r.gt.ok);
  return [
    pendantCard(r),
    lifelogCard(r),
    storeCard(r, "whatsapp", "WhatsApp", r.wa, LIMITS.whatsapp),
    beeperCard(r),
    storeCard(r, "notes", "Notes", r.nt, LIMITS.notes),
    storeCard(r, "imessage", "iMessage", r.im, LIMITS.imessage),
    storeCard(r, "mail", "Mail", r.ml, LIMITS.mail),
    {
      ...git,
      facts: [
        { at: r.gt.ok ? r.gt.value.at : null, label: "Newest commit" },
        { label: "Repo", value: r.gt.ok ? (r.gt.value.newest ?? "?") : "?" },
        {
          label: "Repos with commits today",
          value: r.gt.ok ? String(r.gt.value.today) : "?",
        },
      ],
      group: "sources",
      headline: git.word,
      id: "git",
      name: "Git",
    },
    {
      ...(r.contacts.ok
        ? { tone: "ok", word: "readable" }
        : { tone: "bad", word: "unreadable" }),
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
            ask: ASK("that the archive LaunchAgent is not running"),
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
      facts: [
        ...STORES.map((s) => ({
          label: s.name,
          value: r.failingStores.has(s.name) ? "failing" : "copying",
        })),
        { at: r.status.capture.archive.whatsapp, label: "Last pass" },
      ],
      group: "capture",
      headline: archiveUp ? `every 5 s · ${STORES.length} stores` : "stopped",
      id: "archive",
      name: "Archive",
    },
    {
      ...firstOf(
        [
          !watching,
          {
            ask: ASK("that the watcher LaunchAgent is not running"),
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
const STEPS = [
  "memory.repos",
  "memory.files",
  "memory.moments",
  "memory.extract",
  "memory.closeness",
  "memory.pages",
];
/** The night alone maps the repos and judges closeness. */
const NIGHT_ONLY = new Set(["memory.repos", "memory.closeness"]);

/** A sweep's stations: done, the one running now, still to come. */
function stationsOf(id: string, proc: Processing, children: string[]) {
  const kids = new Set(children.map((c) => c.split("/")[0]));
  const stateOf = (o: string): "done" | "now" | "todo" => {
    if (proc.phase === o) {
      return "now";
    }
    return kids.has(o) ? "done" : "todo";
  };
  return STEPS.filter((o) => id === "nightly" || !NIGHT_ONLY.has(o)).map(
    (o) => ({
      name: o.replace("memory.", ""),
      state: stateOf(o),
    })
  );
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
  const failedAt = String(latest?.result?.failedAt ?? "?");
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
            `the ${name.toLowerCase()} run of ${latest?.startedAt} failed at ${failedAt}`
          ),
          tone: "bad",
          word: "failed",
        },
      ],
      [!!latest, { tone: "ok", word: "ok" }],
      [true, { tone: "idle", word: "none in 7 days" }]
    ),
    at: running ? proc.since : latest?.endedAt,
    facts: sweepFacts(s, next),
    group: "pipeline",
    headline: firstOf(
      [running, { tone: "busy", word: "running since" }],
      [!!latest?.endedAt, { tone: "ok", word: "ran" }],
      [true, { tone: "idle", word: "idle" }]
    ).word,
    id,
    name,
    stations:
      running || latest
        ? stationsOf(id, proc, latest?.children ?? [])
        : undefined,
  };
}

function backupCard(r: Reads): Card {
  const b = readJson<{ bytes?: number; error?: string; okAt?: string }>(
    join(ROOT, "derived", "backup.json")
  );
  const old = !b?.okAt || r.t - Date.parse(b.okAt) > 48 * HOUR;
  return {
    ...firstOf(
      [
        !!b?.error,
        {
          ask: ASK(`the backup failing: ${b?.error}`),
          tone: "bad",
          word: "failed",
        },
      ],
      [old, { tone: "warn", word: "old" }],
      [true, { tone: "ok", word: "ok" }]
    ),
    at: b?.okAt,
    facts: [
      { at: b?.okAt, label: "Last snapshot" },
      { label: "Size", value: `${((b?.bytes ?? 0) / 1e9).toFixed(1)} GB` },
      ...(b?.error ? [{ label: "Error", value: b.error }] : []),
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
            ask: ASK(
              `that truth/ no longer validates: ${clip(truth.error, 200)}`
            ),
            tone: "bad",
            word: "refused",
          }
        : { tone: "ok", word: "valid" }),
      facts: [
        { at: truth.editedAt, label: "Last edited" },
        { label: "People", value: String(truth.people) },
        { label: "Projects", value: String(truth.projects) },
        ...(truth.error
          ? [{ label: "Refused", value: clip(truth.error, 200) }]
          : []),
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
  const sub = readJson<{
    delivered?: number;
    subscription?: { refreshBefore: string; verifiedAt: string };
  }>(join(ROOT, "derived", "events.json"));
  const lines = linesOf(ACTIONS).length;
  const atlasCalls = since(r.mcp, DAY, r.t).filter(
    (c) => clientName(c.agent) === "ChatGPT (Atlas)"
  );
  const tasks = taskList(r.t);
  const needing = tasksOf().filter((x) => escalation(x, r.t)).length;
  return [
    {
      ...(subscribed(r.t)
        ? { tone: "ok", word: "subscribed" }
        : {
            ask: ASK("that Atlas holds no live subscription to asks"),
            tone: "bad",
            word: "no subscription",
          }),
      facts: [
        { at: sub?.subscription?.verifiedAt, label: "Subscription verified" },
        { at: sub?.subscription?.refreshBefore, label: "Refresh before" },
        { label: "Ledger lines delivered", value: String(sub?.delivered ?? 0) },
        {
          label: "Waiting",
          value: String(Math.max(0, lines - (sub?.delivered ?? lines))),
        },
        { at: atlasCalls.at(-1)?.at, label: "Last call" },
      ],
      flow: sub?.delivered,
      group: "outputs",
      headline: subscribed(r.t) ? "subscribed" : "not subscribed",
      id: "atlas",
      name: "Atlas",
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
      name: "Atlas tasks",
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
      ...(failed
        ? { tone: "warn", word: "a failure" }
        : { tone: "ok", word: "ready" }),
      content: acts
        .slice(-5)
        .map(
          (a) => `${a.kind} ${String(a.after?.title ?? a.before?.title ?? "")}`
        ),
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
          at: mails.findLast((m) =>
            String(m.key ?? m.subject ?? "").includes("nightly")
          )?.at,
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
    return { headline: "running", launchd: "running" };
  }
  return sv.ok
    ? { headline: "between ticks", launchd: "between ticks (every 30 min)" }
    : { headline: "down", launchd: `not running (last exit ${sv.status})` };
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
      const { headline, launchd } = serviceState(sv);
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
        facts: [{ label: "launchd", value: launchd }],
        group: "mac",
        headline,
        id: `service-${sv.name.replaceAll(" ", "-")}`,
        name: sv.name,
      };
    }),
  ];
}

const RUN_TONES: Record<string, Tone> = { ok: "ok", running: "busy" };

/** The last 24 h: runs, failures (the watcher's retries apart), sends and the Mac's sleeps. */
function todayOf(r: Reads): Tick[] {
  return [
    ...r.swept.items
      .filter((x) => x.startedAt && r.t - Date.parse(x.startedAt) < DAY)
      .map((x) => ({
        at: x.startedAt ?? "",
        end: x.endedAt ?? undefined,
        label: `${x.step.replace("memory.", "")} ${x.outcome}`,
        tone: RUN_TONES[x.outcome] ?? "bad",
      })),
    // The watcher retries lifelog on its own: a timeout is a retry, not a failure.
    ...r.errorsToday.map((e) => ({
      at: e.at,
      label: `${e.step}: ${clip(String(e.error), 60)}`,
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

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** The snapshot with none of his words, as it may leave the Mac: content and asks dropped. */
export const strip = (s: Snapshot): Snapshot => ({
  ...s,
  cards: s.cards.map(({ ask: _a, content: _c, ...c }) => c),
});

// --- a card's detail: its history, its raw log lines, and a run's steps and what it wrote ----------------------------

export interface Entry {
  at: string;
  /** His words in it: hidden in privacy mode. */
  content?: string;
  end?: string | null;
  /** A run the page can open (`runDetail`). */
  run?: string;
  sub?: string;
  title: string;
  tone: Tone;
}

/** The log lines each card's history is made of. */
const LOGS: Record<string, (e: Line) => boolean> = {
  archive: (e) => e.step?.startsWith("archive.") ?? false,
  atlas: (e) =>
    e.kind === "event.sent" ||
    (e.kind === "mcp.call" && clientName(e.agent) === "ChatGPT (Atlas)"),
  backup: (e) =>
    e.step === "backup" || e.step?.startsWith("memory.nightly.backup") === true,
  beeper: (e) => e.kind === "source.read" && e.source === "beeper",
  clients: (e) => e.kind === "mcp.call",
  connector: (e) => e.kind === "mcp.call",
  contacts: (e) => e.kind === "source.read" && e.source === "contacts",
  email: (e) => e.kind === "email.sent",
  engine: (e) => e.kind === "quota.read" || e.kind === "model.run",
  git: (e) => e.kind === "source.read" && e.source === "git",
  imessage: (e) => e.kind === "source.read" && e.source === "imessage",
  lifelog: (e) =>
    e.step === "watch" || (e.kind === "source.read" && e.source === "lifelog"),
  mail: (e) => e.kind === "source.read" && e.source === "mail",
  notes: (e) =>
    e.step === "archive.notes" ||
    (e.kind === "source.read" && e.source === "notes"),
  past: (e) => e.kind === "calendar.write",
  pendant: (e) => e.kind === "source.read" && e.source === "lifelog",
  reminders: (e) => e.kind === "board.write" || e.kind === "sync.pull",
  tasks: (e) => e.kind === "board.write" || e.kind === "event.sent",
  tunnel: (e) => e.step === "tunnel",
  watcher: (e) => e.step === "watch",
  whatsapp: (e) =>
    e.step === "archive.whatsapp" ||
    (e.kind === "source.read" && e.source === "whatsapp"),
};

/** The sweeps (and the eval) whose history is their runs. */
const RUN_CARDS: Record<string, string> = {
  backfill: "memory.backfill",
  midday: "memory.midday",
  nightly: "memory.nightly",
};

const RUN_OUTCOMES: Record<string, Tone> = {
  ok: "ok",
  running: "busy",
  unfinished: "warn",
};
const toneOfRun = (o: string): Tone => RUN_OUTCOMES[o] ?? "bad";

/** A memory change's colour: a failure red, his correction teal, the rest green. */
const changeTone = (type: string): Tone => {
  if (type.includes("failed")) {
    return "bad";
  }
  return type.startsWith("correction") ? "teal" : "ok";
};

/** One log line as a history entry. */
/** How each kind of log line reads as a history entry: its title, and his words in it. */
const ENTRIES: Record<
  string,
  { content?: (e: Line) => string; title: (e: Line) => string }
> = {
  "email.sent": {
    content: (e) => String(e.subject ?? ""),
    title: () => "email sent",
  },
  "mcp.call": {
    content: (e) => clip(JSON.stringify(e.args ?? {}), 400),
    title: (e) => `${clientName(e.agent)} · ${String(e.tool)}`,
  },
  "model.run": {
    title: (e) =>
      `${String(e.prompt)} · ${Math.round(Number(e.ms ?? 0) / 1000)} s`,
  },
  "quota.read": {
    title: (e) =>
      typeof e.used === "number" ? `quota ${e.used}%` : "quota unread",
  },
  "source.read": {
    title: (e) => `read ${String(e.count ?? 0)} from ${String(e.source)}`,
  },
};

const subOf = (e: Line, bad: boolean) => {
  if (bad) {
    return clip(String(e.error ?? "failed"), 200);
  }
  const tokens = e.tokens as { input: number; output: number } | undefined;
  return tokens
    ? `${Math.round((tokens.input + tokens.output) / 1e3)}k tokens`
    : undefined;
};

/** One log line as a history entry. */
function entryOf(e: Line): Entry {
  const bad = e.kind === "run.error" || e.ok === false || !!e.error;
  const kind = ENTRIES[e.kind];
  return {
    at: e.at,
    content: kind?.content?.(e),
    sub: subOf(e, bad),
    title: kind?.title(e) ?? `${e.kind}${e.step ? ` ${e.step}` : ""}`,
    tone: bad ? "bad" : "ok",
  };
}

const PAGE = 40;

/**
 * A card's detail: its history (newest first, `PAGE` at a time before `before`), and its raw log lines. A sweep's
 * history is its runs; the tasks' their list; the memory's its latest changes; any other card its log lines.
 */
export async function detail(id: string, before?: string) {
  const all = await cached("log7", 15_000, () => recentEvents<Line>(7, ""));
  const older = (at: string) => !before || at < before;
  const pick = LOGS[id];
  const lines = pick ? all.filter((e) => pick(e) && older(e.at)).reverse() : [];
  let history: Entry[];
  const step = RUN_CARDS[id];
  if (step) {
    const { items } = await runs({ limit: PAGE, steps: [step] });
    history = items
      .filter((r) => older(r.startedAt ?? ""))
      .map((r) => ({
        at: r.startedAt ?? r.endedAt ?? "",
        end: r.endedAt,
        run: r.id,
        sub: [
          r.window ? `${r.window.from} → ${r.window.to}` : "",
          spent(r.use) ? useText(r.use ?? null) : "",
          r.outcome === "failed"
            ? `failed at ${String(r.result?.failedAt ?? "?")}`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
        title: `${r.outcome}${r.endedAt && r.startedAt ? ` in ${Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 60_000)} min` : ""}`,
        tone: toneOfRun(r.outcome),
      }));
  } else if (id === "tasks") {
    history = taskList(clock().getTime()).map((x) => ({
      at: x.deadline ?? "",
      content: x.quote,
      sub: `${x.age} old${x.note ? ` · ${x.note}` : ""}`,
      title: `${x.state} · ${x.id}`,
      tone: x.state === "waiting-eric" ? "warn" : "busy",
    }));
  } else if (id === "memory") {
    const { changeFeed } = await import("./memory/feed");
    const feed = await changeFeed({
      limit: 500,
      since: new Date(clock().getTime() - 2 * DAY).toISOString(),
    });
    history = feed.items
      .filter((it) => older(it.recordedAt))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, PAGE)
      .map((it) => ({
        at: it.recordedAt,
        content:
          clip(String((it.record as { text?: string }).text ?? ""), 300) ||
          undefined,
        sub: it.run ?? undefined,
        title: it.type,
        tone: changeTone(it.type),
      }));
  } else if (id === "mac") {
    const s = await cached("sleeps", 5 * MIN, () =>
      safe(() => sleeps(clock().getTime()))
    );
    history = (s.ok ? s.value : [])
      .reverse()
      .map((x) => ({ at: x.at, end: x.end, title: "asleep", tone: "idle" }));
  } else {
    history = lines.slice(0, PAGE).map(entryOf);
  }
  const page = lines.slice(0, PAGE);
  return {
    history,
    log: page.map((e) => JSON.stringify(e)),
    next: page.length === PAGE ? page.at(-1)?.at : null,
  };
}

/** A run: its steps with their counts and time, and what it wrote (`changes` with its run). */
export async function runDetail(id: string) {
  const step = id.split("/")[0] ?? "";
  const { items } = await runs({
    limit: 500,
    steps: [
      step,
      "memory.repos",
      "memory.files",
      "memory.moments",
      "memory.extract",
      "memory.closeness",
      "memory.pages",
    ],
  });
  const run = items.find((r) => r.id === id);
  if (!run) {
    return null;
  }
  const steps = items
    .filter((r) => run.children?.includes(r.id) || r.id === id)
    .filter((r) => r.id !== id)
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const { changeFeed } = await import("./memory/feed");
  const wrote = (
    await Promise.all(
      [run, ...steps].map((r) =>
        changeFeed({ limit: 200, run: r.id }).then((f) => f.items)
      )
    )
  ).flat();
  return {
    run,
    steps: steps.map((r) => ({
      endedAt: r.endedAt,
      errors: r.errors.length,
      id: r.id,
      outcome: r.outcome,
      result: r.result,
      startedAt: r.startedAt,
      step: r.step.replace("memory.", ""),
      use: spent(r.use) ? useText(r.use ?? null) : null,
    })),
    use: spent(run.use) ? useText(run.use ?? null) : null,
    wrote: {
      byType: Object.fromEntries(
        [...Map.groupBy(wrote, (w) => w.type)].map(([k, v]) => [k, v.length])
      ),
      items: wrote.slice(0, 200).map((w) => ({
        at: w.recordedAt,
        content: clip(
          String(
            (w.record as { text?: string }).text ??
              (w.record as { path?: string }).path ??
              ""
          ),
          300
        ),
        id: w.id,
        type: w.type,
      })),
    },
  };
}
