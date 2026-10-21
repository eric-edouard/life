import { clock } from "./clock";
import { ATLAS, clientName } from "./events";
import { recentEvents } from "./log";
import { sleeps } from "./mac";
import { changeFeed } from "./memory/feed";
import { runs, STEPS, useText } from "./memory/history";
import { clip } from "./memory/units";
import { cached, DAY, type Line, spent, type Tone, toneOfRun } from "./plate";
import { SOURCES } from "./sources/index";
import { taskList } from "./tasks";

// A card's detail on the status page (src/dashboard.ts serves it): its history, its raw log lines, and a run's steps
// and what it wrote. Read-only, like the plate (src/plate.ts). His words and errors' text are in `content` only.

export interface Entry {
  at: string;
  /** His words or an error's text: hidden in privacy mode. */
  content?: string;
  end?: string | null;
  /** A run the page can open (`runDetail`). */
  run?: string;
  sub?: string;
  title: string;
  tone: Tone;
}

const read = (name: string) => (e: Line) =>
  e.kind === "source.read" && e.source === name;

/** The log lines each card's history is made of: every source's reads (`SOURCES`), and each part's own lines. */
const LOGS: Record<string, (e: Line) => boolean> = {
  ...Object.fromEntries(SOURCES.map((d) => [d.name, read(d.name)])),
  archive: (e) => e.step?.startsWith("archive.") ?? false,
  atlas: (e) =>
    e.kind === "event.sent" ||
    (e.kind === "mcp.call" && clientName(e.agent) === ATLAS),
  backup: (e) => e.step === "backup",
  clients: (e) => e.kind === "mcp.call",
  connector: (e) => e.kind === "mcp.call",
  contacts: read("contacts"),
  email: (e) => e.kind === "email.sent",
  engine: (e) => e.kind === "quota.read" || e.kind === "model.run",
  lifelog: (e) => e.step === "watch" || read("lifelog")(e),
  past: (e) => e.kind === "calendar.write",
  pendant: read("lifelog"),
  reminders: (e) => e.kind === "board.write" || e.kind === "sync.pull",
  tasks: (e) => e.kind === "board.write" || e.kind === "event.sent",
  tunnel: (e) => e.step === "tunnel",
  watcher: (e) => e.step === "watch",
};

/** The sweeps, whose history is their runs. */
const RUN_CARDS: Record<string, string> = {
  backfill: "memory.backfill",
  midday: "memory.midday",
  nightly: "memory.nightly",
};

/** A memory change's colour: a failure red, his correction teal, the rest green. */
const changeTone = (type: string): Tone => {
  if (type.includes("failed")) {
    return "bad";
  }
  return type.startsWith("correction") ? "teal" : "ok";
};

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

const tokensOf = (e: Line) => {
  const t = e.tokens as { input: number; output: number } | undefined;
  return t ? `${Math.round((t.input + t.output) / 1e3)}k tokens` : undefined;
};

/** One log line as a history entry: a failure's text goes with his words, in `content`. */
function entryOf(e: Line): Entry {
  const bad = e.kind === "run.error" || e.ok === false || !!e.error;
  const kind = ENTRIES[e.kind];
  return {
    at: e.at,
    content: bad ? clip(String(e.error ?? "failed"), 300) : kind?.content?.(e),
    sub: bad ? "failed" : tokensOf(e),
    title: kind?.title(e) ?? `${e.kind}${e.step ? ` ${e.step}` : ""}`,
    tone: bad ? "bad" : "ok",
  };
}

const PAGE = 40;

/** A sweep's runs, newest first, each one the page can open. */
async function runHistory(step: string, older: (at: string) => boolean) {
  const { items } = await runs({ limit: 500, steps: [step] });
  return items
    .filter((r) => older(r.startedAt ?? ""))
    .slice(0, PAGE)
    .map(
      (r): Entry => ({
        at: r.startedAt ?? r.endedAt ?? "",
        content:
          r.outcome === "failed"
            ? `Failed at ${String(r.result?.failedAt ?? "?")}`
            : undefined,
        end: r.endedAt,
        run: r.id,
        sub: [
          r.window ? `${r.window.from} → ${r.window.to}` : "",
          spent(r.use) ? useText(r.use ?? null) : "",
        ]
          .filter(Boolean)
          .join(" · "),
        title:
          r.endedAt && r.startedAt
            ? `${r.outcome} in ${Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 60_000)} min`
            : r.outcome,
        tone: toneOfRun(r.outcome),
      })
    );
}

/** The memory's latest changes, of the last two days. */
async function changeHistory(older: (at: string) => boolean, before?: string) {
  const until = before ? Date.parse(before) : clock().getTime();
  const feed = await changeFeed({
    limit: 500,
    since: new Date(until - 2 * DAY).toISOString(),
  });
  return feed.items
    .filter((it) => older(it.recordedAt))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, PAGE)
    .map(
      (it): Entry => ({
        at: it.recordedAt,
        content:
          clip(String((it.record as { text?: string }).text ?? ""), 300) ||
          undefined,
        sub: it.run ?? undefined,
        title: it.type,
        tone: changeTone(it.type),
      })
    );
}

/** A history that is not its log lines: a sweep's runs, the tasks, the memory's changes, the Mac's sleeps. */
async function ownHistory(
  id: string,
  older: (at: string) => boolean,
  before?: string
) {
  const step = RUN_CARDS[id];
  if (step) {
    return runHistory(step, older);
  }
  if (id === "tasks") {
    return taskList(clock().getTime()).map(
      (x): Entry => ({
        at: x.deadline ?? "",
        content: x.quote,
        sub: `${x.age} old${x.note ? ` · ${x.note}` : ""}`,
        title: `${x.state} · ${x.id}`,
        tone: x.state === "waiting-eric" ? "warn" : "busy",
      })
    );
  }
  if (id === "memory") {
    return changeHistory(older, before);
  }
  if (id === "mac") {
    const s = await cached("sleeps", 5 * 60_000, () =>
      sleeps(clock().getTime())
    );
    return s
      .toReversed()
      .map(
        (x): Entry => ({ at: x.at, end: x.end, title: "asleep", tone: "idle" })
      );
  }
  return null;
}

/**
 * A card's detail: its history (newest first, `PAGE` at a time before `before`), and its raw log lines. A sweep's
 * history is its runs; the tasks' their list; the memory's its latest changes; any other card its log lines.
 */
export async function detail(id: string, before?: string) {
  // The last 8 days, or as far back as `before` and 8 days more: paging goes back through the whole log.
  const days = before
    ? Math.ceil((clock().getTime() - Date.parse(before)) / DAY) + 8
    : 8;
  const all = before
    ? await recentEvents<Line>(days, "")
    : await cached("log", 5000, () => recentEvents<Line>(8, ""));
  const older = (at: string) => !before || at < before;
  const pick = LOGS[id];
  const lines = pick
    ? all.filter((e) => pick(e) && older(e.at)).toReversed()
    : [];
  const page = lines.slice(0, PAGE);
  const history = (await ownHistory(id, older, before)) ?? page.map(entryOf);
  return {
    history,
    log: page.map((e) => JSON.stringify(e)),
    /** Where each list goes on: pass it back as `before` for its next page; null at its end. */
    next: {
      history: history.length === PAGE ? (history.at(-1)?.at ?? null) : null,
      log: page.length === PAGE ? (page.at(-1)?.at ?? null) : null,
    },
  };
}

/** A run: its steps with their counts, time and colour, and what it wrote (`changes` with its run). */
export async function runDetail(id: string) {
  const step = id.split("/")[0] ?? "";
  const { items } = await runs({ limit: 500, steps: [step, ...STEPS] });
  const run = items.find((r) => r.id === id);
  if (!run) {
    return null;
  }
  const steps = items
    .filter((r) => run.children?.includes(r.id))
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const wrote = (
    await Promise.all(
      [run, ...steps].map((r) =>
        changeFeed({ limit: 200, run: r.id }).then((f) => f.items)
      )
    )
  ).flat();
  return {
    steps: steps.map((r) => ({
      endedAt: r.endedAt,
      id: r.id,
      outcome: r.outcome,
      result: r.result,
      startedAt: r.startedAt,
      step: r.step.replace("memory.", ""),
      tone: toneOfRun(r.outcome),
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
