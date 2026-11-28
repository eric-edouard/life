import { join } from "node:path";
import { cached, safe } from "../../core/cached";
import { clock, DAY, HOUR, MIN } from "../../core/clock";
import { filesIn, newestIn, readLineCount } from "../../core/files";
import { type LogEvent, recentEvents } from "../../core/log";
import { isOn, OUTPUTS } from "../../core/outputs";
import { OWNER_DATA_DIR } from "../../core/paths";
import { git } from "../../core/proc";
import { changeFeed } from "../../memory/changes";
import {
  CORRECTIONS,
  EPISODES,
  OBSERVATIONS,
  PAGES,
  readFactCheckAnswers,
  readFactChecks,
  readLedger,
} from "../../memory/memory-files";
import { loadTruth, TRUTH } from "../../memory/read-truth";
import { runs, type Use, useText } from "../../memory/run-log";
import { enabledSources, keptStores, listening } from "../../memory/sources";
import { clip } from "../../memory/units";
import { hasQuota, llmFor, llmSpec, readEngine } from "../../models/llm";
import { isBookkeeping, TODO_CHANGE_KINDS } from "../../records/ledger-entry";
import { readContacts } from "../../sources/contacts";
import type { Descriptor, Newest } from "../../sources/contract";
import { checks } from "../../todo-list/backend";
import { backupOld, backupSize, readBackup } from "../backup";
import { readHealth } from "../health";
import { inboxChecksNow } from "../inbox";
import {
  type IntegrationHealth,
  integrationHealthOf,
} from "../integration-health";
import { integrationFactsOf, readIntegrationReads } from "../integrations";
import { EMAIL_STEP, mailedTo, reportKey } from "../report";
import { ASK, type Card, type Fact, firstOf, type Tone } from "./card";
import { crashCard } from "./crash-card";
import { deskCard } from "./desk-card";
import { lifeStatus } from "./life";
import { macCard, macState, sleeps } from "./mac";

// The status snapshot (`apps/server/src/host/http/status-reads.ts` serves it to the app): every part of Life as a card in a group, each with its
// state now, read from Life's own records and stores, nothing written. A card's colour is `toneOf`'s rule: red only
// when Life can't read or run a part, grey when it is just quiet, amber when quiet past its source's `silentAfter` (a source with parts: its quietest part). His
// words and any error's text live only in a card's `content`: the app hides them when its "Show content" is off.

export interface Tick {
  at: string;
  end?: string;
  label: string;
  /** The Mac asleep: drawn as a band, not a run. */
  sleep?: true;
  tone: Tone;
}

/** A run's outcome as a colour: the status snapshot and its details use this one. */
const RUN_TONES: Record<string, Tone> = {
  ok: "ok",
  running: "busy",
  unfinished: "warn",
};
export const toneOfRun = (outcome: string): Tone => RUN_TONES[outcome] ?? "bad";

// --- reads: each redone at most every `ms` (the stream asks every few seconds, the push every minute) ---------------

async function memoryCounts() {
  const answers = readFactCheckAnswers();
  const [at] = git(OWNER_DATA_DIR, ["log", "-1", "--format=%cI"])
    .stdout.toString()
    .trim()
    .split("\n");
  const [episodes, observations, people, areas] = await Promise.all([
    filesIn(EPISODES),
    filesIn(OBSERVATIONS),
    filesIn(join(PAGES, "people"), ".md"),
    filesIn(join(PAGES, "areas"), ".md"),
  ]);
  return {
    answered: readFactChecks().filter((s) => answers.get(s.ref)?.answer).length,
    commitAt: at ? new Date(at).toISOString() : null,
    corrections: readLineCount(CORRECTIONS),
    episodes: episodes.length,
    left: await safe(async () => (await inboxChecksNow()).length),
    observations: observations.reduce(
      (n, m) => n + readLineCount(join(OBSERVATIONS, m)),
      0
    ),
    pages: people.length + areas.length,
  };
}

/** His corrections not yet reflected in the index and the pages (`read_memory_changes`' `reflected: false`), 20 pages at most. */
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
  const edited = newestIn(TRUTH);
  const loaded = await safe(loadTruth);
  return {
    editedAt: edited ? new Date(edited).toISOString() : null,
    error: loaded.ok ? null : loaded.error,
    people: loaded.ok ? loaded.value.people.length : 0,
    projects: loaded.ok ? loaded.value.projects.length : 0,
  };
}

export type LogLine = LogEvent & Record<string, unknown>;
const since = (list: LogLine[], ms: number, now: number) =>
  list.filter((e) => now - Date.parse(e.at) < ms);

// --- the status snapshot ------------------------------------------------------------------------------------------------------

export const GROUPS = [
  { id: "sources", name: "Sources" },
  { id: "capture", name: "Capture" },
  { id: "pipeline", name: "Pipeline" },
  { id: "memory", name: "Memory" },
  { id: "outputs", name: "Outputs" },
  { id: "mac", name: "The Mac" },
] as const;

/** A run that recorded any use: runs from before 21 Oct have no tokens and no readings. */
export const spent = (u: Use | null | undefined) =>
  !!u && (u.tokens.input > 0 || !!u.quota?.before || !!u.quota?.after);

/** Every read the status snapshot is made of, each cached for as long as it may lag; the integrations' reads are shared. */
async function reads(now: Date) {
  const t = now.getTime();
  const [integration, rest] = await Promise.all([
    readIntegrationReads(now),
    Promise.all([
      cached("status", 5000, () => lifeStatus(now)),
      cached("log", 5000, () => recentEvents<LogLine>(8, "")),
      cached("mac", 15_000, () => macState()),
      cached("mem", MIN, () => memoryCounts()),
      cached("unreflected", 5 * MIN, () => safe(unreflected)),
      cached("truth", MIN, () => truthState()),
      cached("contacts", 10 * MIN, () => safe(() => readContacts().size)),
      safe(() => cached("sleeps", 5 * MIN, () => sleeps(t))),
      // Every run, a processing run's steps inside it (its use counts theirs): a night that failed before its first call shows too.
      cached("recent runs", 15_000, async () => {
        const page = await runs({ everyStep: true, limit: 30 });
        return {
          ...page,
          items: page.items.filter((x) => !x.processingRun),
        };
      }),
      readLedger(),
      cached("actionChecks", MIN, checks),
    ]),
  ]);
  const [
    status,
    log,
    mac,
    mem,
    open,
    truth,
    contacts,
    sleepList,
    recentRuns,
    actions,
    actionChecks,
  ] = rest;
  const of = (kind: string, days: number) =>
    since(
      log.filter((e) => e.kind === kind),
      days * DAY,
      t
    );
  const mcp = of("mcp.call", 2);
  return {
    ...integration,
    actionChecks,
    actions,
    contacts,
    errorsToday: of("run.error", 1),
    health: readHealth(),
    mac,
    mcp,
    mem,
    models: of("model.run", 1),
    open,
    quotas: of("quota.read", 8),
    recentRuns,
    sent: of("email.sent", 2),
    sleepList,
    status,
    truth,
    writes: of("calendar.write", 2),
  };
}

type Reads = Awaited<ReturnType<typeof reads>>;
const serviceOf = (r: Reads, name: string) =>
  r.mac.services.find((s) => s.name === name);

type Pendant = NonNullable<
  Extract<Reads["life"], { ok: true }>["value"]["pendant"]
>;

const pendantFacts = (
  p: Pendant | null | undefined,
  spokeAt: string | null
): Fact[] => [
  {
    at: p?.recordingKnownAt,
    // The voice server's phone reports each change as it happens: the state stands since then.
    label: "Recording state, since",
    value: p?.recording ?? "unknown",
  },
  {
    label: "Battery",
    value: typeof p?.batteryPercent === "number" ? `${p.batteryPercent}%` : "?",
  },
  { label: "Connection", value: p?.connection ?? "?" },
  { at: p?.knownAt, label: "Phone last reported" },
  { at: spokeAt, label: "Newest speech heard" },
];

/** The Pendant, as the voice server last heard from the phone, and the newest speech the watcher folded in. */
function pendantCard(r: Reads, d: Descriptor, h: IntegrationHealth): Card {
  const pendant = r.life.ok ? r.life.value.pendant : undefined;
  const spokeAt = r.turn.ok ? (r.turn.value ?? null) : null;
  return {
    tone: h.tone,
    word: h.word,
    ...(h.state === "broken" ? { ask: ASK(`that ${d.label}: ${h.why}`) } : {}),
    facts: pendantFacts(pendant, spokeAt),
    group: "sources",
    // Red when the newest speech can't be read: why, not the phone's state.
    headline: r.turn.ok
      ? (pendant?.recording ?? "unknown")
      : clip(String(r.turn.error), 200),
    id: "pendant",
    name: d.label,
  };
}

/** What the voice server card says: why when the watcher stopped polling (its last error), else whether it ever polled. */
const polledHeadline = (r: Reads) => {
  if (r.status.watcher.state !== "ok") {
    return r.health?.lastError ?? "no poll for 15 minutes";
  }
  return r.health?.lastOkAt ? "polling" : "never polled";
};

function voiceServerCard(r: Reads): Card {
  const retrying = (r.health?.consecutiveErrors ?? 0) > 0;
  const backlog = r.life.ok
    ? r.life.value.phoneHeartbeat?.backlog?.pages
    : undefined;
  return {
    ...firstOf(
      [
        r.status.watcher.state !== "ok",
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
    group: "sources",
    headline: polledHeadline(r),
    id: "lifelog",
    name: "lifelog server",
  };
}

/** A source card's facts: its newest item (each part's), its last copy, how long its store has been failing. */
const sourceFacts = (
  n: Newest,
  copiedAt: string | null | undefined,
  failingSince: string | undefined
): Fact[] => [
  { at: n.at, label: n.parts?.length ? "Newest" : "Last item" },
  ...(n.parts ?? []).map((p) => ({ at: p.at, label: p.label })),
  ...(copiedAt === undefined ? [] : [{ at: copiedAt, label: "Last copied" }]),
  ...(n.facts ?? []),
  ...(failingSince ? [{ at: failingSince, label: "Failing since" }] : []),
];

/** A source read from its own store (`Descriptor.newest`): its newest item, its last copy, its failure. */
function sourceCard(r: Reads, d: Descriptor, h: IntegrationHealth): Card {
  const read = r.newest.get(d.name) ?? {
    error: "not read",
    ok: false as const,
  };
  const n: Newest = read.ok ? read.value : { at: null };
  const broken = r.failingStores.get(d.name);
  // The archive's stores: when it last copied one in (lifeStatus).
  const copiedAt = r.status.capture.archive[d.name];
  const red = h.tone === "bad";
  // Why it is red, in the app, its ask and the source alert.
  const cause = h.why ?? "cannot be read";
  return {
    tone: h.tone,
    word: h.word,
    ...(red ? { ask: ASK(`that ${d.label}: ${cause}`) } : {}),
    content: [
      ...(n.words ?? []).map((w) => clip(w, 140)),
      ...(h.why
        ? [
            h.word === "bridge down"
              ? clip(h.why, 300)
              : `Error: ${clip(h.why, 300)}`,
          ]
        : []),
    ],
    facts: sourceFacts(n, copiedAt, broken?.at),
    group: "sources",
    headline: red ? clip(cause, 200) : h.word,
    id: d.name,
    name: d.label,
  };
}

/**
 * A source he turned on that can't be read now (not set up, or its access gone): what it needs. Its units are kept. An
 * imported one with nothing imported is idle: nothing fails, there is nothing to read yet. Its headline is what it waits
 * on (`integrationHealthOf`'s why).
 */
const unreadableCard = (d: Descriptor, h: IntegrationHealth): Card => ({
  facts: [],
  group: "sources",
  headline: h.why ?? "",
  id: d.name,
  name: d.label,
  tone: h.tone,
  word: h.word,
});

function sourceCards(r: Reads): Card[] {
  return [
    ...enabledSources().flatMap((d) => {
      const h = integrationHealthOf(integrationFactsOf(d, r));
      if (h.state === "waiting_on_user") {
        return [unreadableCard(d, h)];
      }
      return d.kind === "voice"
        ? [pendantCard(r, d, h), voiceServerCard(r)]
        : [sourceCard(r, d, h)];
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
      headline: r.contacts.ok
        ? "readable"
        : clip(String(r.contacts.error), 200),
      id: "contacts",
      name: "Contacts",
    },
  ];
}

function captureCards(r: Reads): Card[] {
  const archiveUp = serviceOf(r, "archive")?.running;
  const watching = serviceOf(r, "watch")?.running;
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
          r.status.watcher.state !== "ok",
          {
            ask: ASK("that the watcher is running but not polling"),
            tone: "bad",
            word: "not polling",
          },
        ],
        [true, { tone: "ok", word: "hearing" }]
      ),
      facts: [
        { at: r.health?.lastPollAt, label: "Last poll" },
        { label: "Asks heard today", value: String(asksToday) },
      ],
      group: "capture",
      headline: r.status.watcher.state === "ok" ? "hearing" : "not polling",
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
      group: "capture",
      headline: `${calls.length} calls today`,
      id: "connector",
      name: OUTPUTS.connector.label,
      ...(isOn("connector")
        ? { tone: "ok", word: "serving" }
        : { tone: "idle", word: "off" }),
    },
  ];
}

interface Processing {
  processingRun?: string | null;
  processingStep?: string | null;
  since?: string;
  state: string;
}
type ProcessingRun = Reads["status"]["nightly"];

/** A nightly report's email (`reportKey`), by its key. */
const isReport = (key: unknown) => String(key ?? "").startsWith(reportKey(""));

/**
 * A processing run's processing steps: those its last good run went through (its steps among them) and any its latest
 * added, done, now or left to do (where it failed); for the night, then its report, done once that email went.
 */
export function processingStepsOf(
  s: Pick<ProcessingRun, "lastOk" | "latest">,
  running: boolean,
  reported: boolean | null
) {
  const latest = s.latest?.processingSteps ?? [];
  const names = [...new Set([...(s.lastOk?.processingSteps ?? []), ...latest])];
  const now = running ? latest.at(-1) : undefined;
  const failedAt =
    s.latest?.outcome === "failed"
      ? String(s.latest.result?.failedAt)
      : undefined;
  const stepStatusOf = (name: string): "done" | "now" | "todo" => {
    if (name === now) {
      return "now";
    }
    return latest.includes(name) && name !== failedAt ? "done" : "todo";
  };
  const steps = names.map((name) => ({ name, state: stepStatusOf(name) }));
  return reported === null
    ? steps
    : [
        ...steps,
        {
          name: "email",
          state: reported ? ("done" as const) : ("todo" as const),
        },
      ];
}

const processingRunFacts = (
  s: ProcessingRun,
  next?: { earliest: string; why: string }
): Fact[] => [
  { at: s.lastOk?.endedAt, label: "Last ok" },
  { at: s.lastFailed?.endedAt, label: "Last failed" },
  ...(next ? [{ at: next.earliest, label: `Next (${next.why})` }] : []),
  ...(spent(s.latest?.use)
    ? [{ label: "Last run used", value: useText(s.latest?.use ?? null) }]
    : []),
];

/** A processing run: its last run, its processing steps, what it spent, and when it runs next. */
function processingRunCard(
  r: Reads,
  id: string,
  name: string,
  s: ProcessingRun,
  next?: { earliest: string; why: string }
): Card {
  const proc = r.status.processing as Processing;
  const running =
    proc.state === "running" &&
    !!proc.processingRun?.startsWith(`memory.${id}/`);
  const step = proc.processingStep?.replace("memory.", "") ?? "running";
  const { latest } = s;
  const headline = firstOf(
    [running, { tone: "busy", word: "running since" }],
    [!!latest?.endedAt, { tone: "ok", word: "ran" }],
    [true, { tone: "idle", word: "idle" }]
  ).word;
  return {
    ...firstOf(
      [running, { tone: "busy", word: step }],
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
    facts: processingRunFacts(s, next),
    group: "pipeline",
    headline,
    id,
    name,
    processingSteps:
      running || latest
        ? processingStepsOf(
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
      [!isOn("backup"), { tone: "idle", word: "off" }],
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
    name: OUTPUTS.backup.label,
  };
}

function engineCard(r: Reads): Card {
  const metered = hasQuota();
  // An older engine's reading never shows on one with no quota.
  const q = metered
    ? (r.quotas.findLast((x) => typeof x.used === "number") as
        | { resetsAt?: string; used: number }
        | undefined)
    : undefined;
  const week = r.recentRuns.items.filter(
    (x) => spent(x.use) && r.t - Date.parse(x.startedAt ?? "") < 7 * DAY
  );
  const tokens = week.reduce(
    (n, x) => n + (x.use?.tokens.input ?? 0) + (x.use?.tokens.output ?? 0),
    0
  );
  const thinking =
    (r.status.processing as Processing).state === "running" ||
    since(r.models, 2 * MIN, r.t).length > 0;
  // With a quota, how full it is; else the model as he would name it, the deep tier's without its author and hosts.
  const quotaText = q ? `${q.used}% of the week` : "quota not read";
  const headline = metered
    ? quotaText
    : (llmFor("deep").model.split("@")[0]?.split("/").at(-1) ?? "");
  return {
    ...firstOf(
      [metered && !q, { tone: "idle", word: "unread" }],
      [(q?.used ?? 0) > 75, { tone: "warn", word: "over reserve" }],
      [thinking, { tone: "busy", word: "thinking" }],
      [true, { tone: "ok", word: metered ? "spare" : "ready" }]
    ),
    facts: [
      // What each tier shows, engine/model@hosts/effort (`Tier`, llm.ts); the judge is a yardstick, not listed.
      ...(["deep", "main", "fast"] as const).map((tier) => ({
        label: `Model (${tier})`,
        value: llmSpec(llmFor(tier)),
      })),
      ...(metered
        ? [
            { label: "Quota used", value: q ? `${q.used}%` : "not read" },
            { at: q?.resetsAt, label: "Resets" },
          ]
        : []),
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
    headline,
    id: "engine",
    name: `Engine · ${readEngine()}`,
  };
}

/** A calendar Life writes to: its events written in 2 days, told apart by what each shows (`by`, a log field); failing when its sync, run twice an hour, failed within the hour. */
function calendarCard(
  r: Reads,
  id: "appointments" | "past",
  by: "appointment" | "episode"
): Card {
  const writes = r.writes.filter((e) => by in e);
  const n = writes.length;
  const failed = since(r.errorsToday, HOUR, r.t).findLast((e) => e.step === id);
  return {
    content: failed && [`${failed.error}`],
    facts: [{ at: writes.at(-1)?.at, label: "Last event written" }],
    group: "pipeline",
    headline: n ? `${n} events in 2 days` : "nothing written in 2 days",
    id,
    name: OUTPUTS[`${id}Calendar`].label,
    ...firstOf(
      [!isOn(`${id}Calendar`), { tone: "idle", word: "off" }],
      [!!failed, { tone: "warn", word: "failing" }],
      [n > 0, { tone: "ok", word: "syncing" }],
      [true, { tone: "idle", word: "quiet" }]
    ),
  };
}

function pipelineCards(r: Reads): Card[] {
  const { nightly } = r.status;
  return [
    processingRunCard(r, "nightly", "Nightly", nightly, nightly.next),
    backupCard(r),
    engineCard(r),
    calendarCard(r, "past", "episode"),
    calendarCard(r, "appointments", "appointment"),
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
        { label: "Days of episodes", value: String(mem.episodes) },
        { label: "Corrections", value: String(mem.corrections) },
        {
          label: "Not yet reflected",
          value: open.ok ? String(open.value) : "?",
        },
        {
          label: "Fact checks answered",
          value: String(mem.answered),
        },
        { at: mem.commitAt, label: "Last commit" },
      ],
      group: "memory",
      headline: `${mem.observations.toLocaleString("en-US")} observations`,
      id: "memory",
      name: "Memory",
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

/** Who made a connector call, as the cards name it: its agent (its grant's claim), or a plain app. */
export const callerOf = (agent: unknown) =>
  typeof agent === "string" ? agent : "an app";

function outputCards(r: Reads): Card[] {
  const { left } = r.mem;
  const calls = since(r.mcp, DAY, r.t);
  const byClient = Map.groupBy(calls, (c) => callerOf(c.agent));
  const acts = r.actions.filter(
    (a) =>
      (TODO_CHANGE_KINDS as readonly string[]).includes(a.kind) &&
      !isBookkeeping(a) &&
      r.t - Date.parse(a.at) < DAY
  );
  const failed = acts.filter((a) => a.result === "failed").length;
  const mailFailed = r.errorsToday.filter((e) =>
    String(e.step).startsWith(EMAIL_STEP)
  ).length;
  const mails = since(r.sent, DAY, r.t);
  return [
    {
      content: calls
        .slice(-5)
        .map(
          (c) =>
            `${callerOf(c.agent)} · ${c.tool}: ${clip(JSON.stringify(c.args ?? {}), 120)}`
        ),
      facts: [...byClient].map(([name, list]) => ({
        label: name,
        value: `${list.length} calls, last ${list.at(-1)?.tool}`,
      })),
      group: "outputs",
      headline: `${byClient.size} client${byClient.size === 1 ? "" : "s"} today`,
      id: "clients",
      name: "MCP clients",
      tone: byClient.size ? "ok" : "idle",
      word: byClient.size ? "connected" : "quiet",
    },
    {
      ...firstOf(
        [!isOn("todoList"), { tone: "idle", word: "off" }],
        [
          r.actionChecks.length > 0,
          {
            ask: ASK("that Life can't reach its actions backend"),
            tone: "bad",
            word: "unreachable",
          },
        ],
        [failed > 0, { tone: "warn", word: "a failure" }],
        [true, { tone: "ok", word: "ready" }]
      ),
      content: [
        ...r.actionChecks,
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
      name: OUTPUTS.todoList.label,
    },
    {
      ...firstOf(
        [mailFailed > 0, { tone: "warn", word: `${mailFailed} failed` }],
        [!mailedTo(), { tone: "idle", word: "kept on the Mac" }],
        [true, { tone: "ok", word: "sending" }]
      ),
      content: mails.map((m) => String(m.key ?? "")),
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
      group: "outputs",
      headline: `${mails.length} sent today`,
      id: "email",
      name: "Email",
    },
    {
      ...(left.ok
        ? {
            tone: "ok",
            word: left.value === 0 ? "all answered" : "waiting",
          }
        : { tone: "bad", word: "unreadable" }),
      content: left.ok ? undefined : [`Error: ${left.error}`],
      facts: [
        { label: "Left to answer", value: String(left.ok && left.value) },
      ],
      group: "outputs",
      headline: left.ok ? `${left.value} to answer` : clip(left.error, 200),
      id: "check",
      name: "Fact checks",
    },
  ];
}

/** The last 24 h: runs, failures (the watcher's retries apart), sends and the Mac's sleeps. */
function todayOf(r: Reads): Tick[] {
  return [
    ...r.recentRuns.items
      .filter((x) => x.startedAt && r.t - Date.parse(x.startedAt) < DAY)
      .map((x) => ({
        at: x.startedAt ?? "",
        end: x.endedAt ?? undefined,
        label: `${x.step.replace("memory.", "")} ${x.outcome}`,
        tone: toneOfRun(x.outcome),
      })),
    // The watcher retries the voice server on its own: a timeout is a retry, not a failure.
    ...r.errorsToday.map((e) => ({
      at: e.at,
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
          sleep: true as const,
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

/** Everything in the status snapshot now. */
export async function snapshot(now = clock()) {
  const r = await reads(now);
  const cards = [
    ...sourceCards(r),
    ...captureCards(r),
    crashCard(r.errorsToday, r.t),
    ...pipelineCards(r),
    ...memoryCards(r),
    ...outputCards(r),
    deskCard(r.t),
    macCard(r.mac),
  ];
  // One rule for a card in trouble: the app's menu and window list them.
  const trouble = cards
    .filter((c) => c.tone === "bad" || c.tone === "warn")
    .map((c) => c.id);
  return {
    cards,
    groups: GROUPS,
    observedAt: now.toISOString(),
    today: todayOf(r),
    trouble,
    worst: cards.reduce<Tone>(
      (w, c) => (RANK[c.tone] > RANK[w] ? c.tone : w),
      "ok"
    ),
  };
}
