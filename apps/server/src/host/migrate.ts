import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { log } from "../core/log";
import { isOn } from "../core/outputs";
import { LIFE_STATE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { SETTINGS } from "../core/settings";
import { locked } from "../memory/memory-lock";
import { momentId } from "../memory/moments";
import { observationId } from "../memory/observe";
import { lineHash } from "../memory/page-format";
import { commitMemory } from "../memory/run";
import { unitId } from "../memory/units";
import { backend, pull } from "../todo-list/backend";
import { taskOf } from "../todo-list/board";

// A rename backfills (AGENTS.md): the stored names the owner chose on 22 Oct 2026 (docs/glossary.md), written once
// into his data at Life's next start, under the lock, and committed in his data repo before and after. Every line
// keeps its place (the `changes` cursor and the events' delivery count lines). truth/ and the archive are never
// touched. After it the code reads only the new names. The rewrite is a pure function of the files (`renameStored`),
// so it is tested on made-up data; `migrateStored` reads, writes and commits.

/** The ledger's old file: while it is there, the rename has not run. */
const OLD_LEDGER = "memory/actions.jsonl";
const NEW_LEDGER = "memory/ledger.jsonl";

const TYPES: Record<string, string> = {
  person: "about_a_person",
  todo: "to_do",
  waiting: "waiting_on_someone",
};
const OLD_AGENT = "atlas";
const NEW_AGENT = "agent";
const ID = /\b(u|act|obs|mom)_([0-9a-f]{12})\b/g;
const INFERRED = /\bperson:inf-/g;
const AGENT_REF = /^(unknown:)?atlas(?=$|:)/;
const INFERRED_ID = /^inf-/;
const INFERRED_PAGE = /^(memory\/pages\/people\/)inf-/;
const OLD_TASK = /^act_(?=[0-9a-f]{12}$)/;
const STORED = /\.(jsonl|md|json)$/;

const isJsonl = (path: string) => path.endsWith(".jsonl");
const under = (path: string, dir: string) => path.startsWith(`${dir}/`);
const type = (t: string) => TYPES[t] ?? t;

/** Every record in the JSON Lines files under `dir`. */
// biome-ignore lint/suspicious/noExplicitAny: records of every kind, read before any schema knows the new names
const rowsIn = (files: Map<string, string>, dir: string): any[] =>
  [...files]
    .filter(([path]) => under(path, dir) && isJsonl(path))
    .flatMap(([, text]) => text.split("\n").filter((l) => l.trim()))
    .map((l) => JSON.parse(l));

/** The old unit recipe: the same parts as `unitId`, the old prefix. */
const oldUnitId = (...parts: string[]) => `u_${unitId(...parts).slice(5)}`;

/** The agent's units: its word and its tasks' ids are in their recipe (source, chat, day), so their ids change. */
function agentUnits(files: Map<string, string>) {
  return new Map(
    rowsIn(files, "memory/units")
      .filter(
        (u) =>
          u.source === OLD_AGENT && u.id === oldUnitId(OLD_AGENT, u.key, u.date)
      )
      .map((u) => [
        u.id as string,
        unitId(
          NEW_AGENT,
          String(u.key).replace(ID, (_, p, h) => newPrefix(p, h)),
          u.date
        ),
      ])
  );
}

/** Observations minted from their unit and type: minted again from the new ones (an older recipe's keep theirs). */
function observationIds(
  files: Map<string, string>,
  unit: (id: string) => string
) {
  return new Map(
    rowsIn(files, "memory/observations")
      .filter((o) => o.id === observationId(o.unit, o.type, o.quote, o.text))
      .map((o) => [
        o.id as string,
        observationId(unit(o.unit), type(o.type), o.quote, o.text),
      ])
  );
}

/** Moments minted from their units: minted again from the new ones; a later day's line continues the first's id. */
function momentIds(files: Map<string, string>, unit: (id: string) => string) {
  const ids = new Map<string, string>();
  for (const m of rowsIn(files, "memory/moments")) {
    const key = [m.day, m.start ?? "", ...[...m.units].toSorted()];
    const now = [m.day, m.start ?? "", ...m.units.map(unit).toSorted()];
    const found = [[], [m.title]].find(
      (extra) => m.id === momentId([...key, ...extra])
    );
    if (found && !ids.has(m.id)) {
      ids.set(m.id, momentId([...now, ...found]));
    }
  }
  return ids;
}

/** Each old id's new one, from the records that mint them (the rest only change their prefix). */
function idMaps(files: Map<string, string>) {
  const agents = agentUnits(files);
  const unit = (id: string) =>
    id.startsWith("u_") ? (agents.get(id) ?? `unit_${id.slice(2)}`) : id;
  return {
    moments: momentIds(files, unit),
    observations: observationIds(files, unit),
    unit,
  };
}

function newPrefix(prefix: string, hex: string) {
  return prefix === "act" ? `entry_${hex}` : `${prefix}_${hex}`;
}

type Maps = ReturnType<typeof idMaps>;

/** A string with every old id in it renamed; quotes are the source's own words and are never touched. */
const renamed = (s: string, m: Maps) =>
  s
    .replace(ID, (id, p, hex) => {
      if (p === "u") {
        return m.unit(id);
      }
      if (p === "obs") {
        return m.observations.get(id) ?? id;
      }
      if (p === "mom") {
        return m.moments.get(id) ?? id;
      }
      return newPrefix(p, hex);
    })
    .replace(INFERRED, "person:inf_");

/** The agent's old word where it is a stored value (a source, a target, a sender, a ref's prefix), never in prose. */
const agentWord = (s: string) =>
  s === OLD_AGENT
    ? NEW_AGENT
    : s.replace(AGENT_REF, (_, u) => `${u ?? ""}${NEW_AGENT}`);

/** The keys each file renames: `[old, new]` at the top of each line. */
const KEYS: [RegExp, [string, string][]][] = [
  [/^memory\/verdicts\.jsonl$/, [["salience", "importance"]]],
  [/^memory\/observations\//, [["salience", "importance"]]],
  [/^memory\/actions\.jsonl$/, [["madeBy", "via"]]],
  [/^memory\/(statements|ratings)\.jsonl$/, [["claim", "ref"]]],
];
/** The files whose `type` is an observation's type. */
const TYPED = /^memory\/(verdicts\.jsonl|labels\.jsonl|observations\/)/;

function value(v: unknown, key: string, m: Maps): unknown {
  if (typeof v === "string") {
    return key === "quote" ? v : agentWord(renamed(v, m));
  }
  if (Array.isArray(v)) {
    return v.map((x) => value(x, key, m));
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, value(x, k, m)])
    );
  }
  return v;
}

function row(path: string, r: Record<string, unknown>, m: Maps) {
  const keys = new Map(KEYS.flatMap(([re, ks]) => (re.test(path) ? ks : [])));
  const out = Object.fromEntries(
    Object.entries(r).map(([k, v]) => [keys.get(k) ?? k, value(v, k, m)])
  );
  if (TYPED.test(path) && typeof out.type === "string") {
    out.type = type(out.type);
  }
  // An inferred person's own id has no `person:` before it.
  if (path === "memory/people-inferred.jsonl" && typeof out.id === "string") {
    out.id = out.id.replace(INFERRED_ID, "inf_");
  }
  return out;
}

/** A page: ids renamed in it, and its generated lines' hashes moved to the lines as they now read. */
function page(text: string, m: Maps) {
  const lines = text.split("\n");
  const front = lines.findIndex((l, i) => i > 0 && l === "---");
  const at = lines.findIndex((l, i) => i < front && l.startsWith("lines: "));
  if (front < 0 || at < 0) {
    return renamed(text, m);
  }
  const hashes = JSON.parse(lines[at]?.slice(7) ?? "{}") as Record<
    string,
    string[]
  >;
  const moved = new Map(
    lines
      .slice(front + 1)
      .map((l) => [lineHash(l), lineHash(renamed(l, m))] as const)
  );
  const next = Object.fromEntries(
    Object.entries(hashes).map(([h, cites]) => [
      moved.get(h) ?? h,
      cites.map((c) => renamed(c, m)),
    ])
  );
  return lines
    .map((l, i) =>
      i === at ? `lines: ${JSON.stringify(next)}` : renamed(l, m)
    )
    .join("\n");
}

/**
 * The rename on the owner data dir's files (path relative to it -> text): the changed files and the files to move.
 * Pure: every id is renamed the way the code now mints it, so a later reading of the same unit, moment or claim finds
 * the same id.
 */
export function renameStored(files: Map<string, string>) {
  const m = idMaps(files);
  const out = new Map<string, string>();
  const moves: [string, string][] = [];
  for (const [path, text] of files) {
    let next = text;
    if (isJsonl(path)) {
      next = text
        .split("\n")
        .map((l) => {
          if (!l.trim()) {
            return l;
          }
          const was = JSON.parse(l) as Record<string, unknown>;
          const now = row(path, was, m);
          return JSON.stringify(now) === JSON.stringify(was)
            ? l
            : JSON.stringify(now);
        })
        .join("\n");
    } else if (path.endsWith(".md") && under(path, "memory/pages")) {
      next = page(text, m);
    } else if (path.endsWith(".json")) {
      next = `${JSON.stringify(value(JSON.parse(text), "", m), null, 2)}\n`;
      next =
        next === `${JSON.stringify(JSON.parse(text), null, 2)}\n` ? text : next;
    }
    if (next !== text) {
      out.set(path, next);
    }
    const moved =
      path === OLD_LEDGER ? NEW_LEDGER : path.replace(INFERRED_PAGE, "$1inf_");
    if (moved !== path) {
      moves.push([path, moved]);
    }
  }
  return { files: out, moves };
}

/** The settings file's old names, renamed in place (Life's state, not his data): the `actions` key, the agent's word. */
export function renameSettings(path = SETTINGS) {
  if (!existsSync(path)) {
    return;
  }
  const text = readFileSync(path, "utf8");
  const { actions, ...raw } = JSON.parse(text) as Record<string, unknown>;
  const sources = Array.isArray(raw.sources)
    ? { sources: raw.sources.map((s) => (s === OLD_AGENT ? NEW_AGENT : s)) }
    : {};
  const next = `${JSON.stringify({ ...raw, ...sources, ...(actions === undefined ? {} : { todo_list: actions }) }, null, 2)}\n`;
  if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(JSON.parse(text))) {
    writeFileSync(path, next);
  }
}

/** The files the rename reads: memory/ (JSON Lines and pages) and the regression cases. */
function readStored() {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (STORED.test(e.name)) {
        files.set(relative(OWNER_DATA_DIR, p), readFileSync(p, "utf8"));
      }
    }
  };
  for (const dir of ["memory", "docs/evals/cases"]) {
    if (existsSync(join(OWNER_DATA_DIR, dir))) {
      walk(join(OWNER_DATA_DIR, dir));
    }
  }
  return files;
}

export const needsRename = () => existsSync(join(OWNER_DATA_DIR, OLD_LEDGER));

/** Runs the rename once, holding memory's lock; its callers wait while another process runs it. */
export async function migrateStored() {
  renameSettings();
  while (needsRename()) {
    // biome-ignore lint/performance/noAwaitInLoops: waits for the process that holds the lock to finish the rename
    const done = await locked(async () => {
      if (!needsRename()) {
        return true;
      }
      const paths = ["memory", "docs/evals"];
      commitMemory(paths, "Memory: before the stored names' rename");
      const { files, moves } = renameStored(readStored());
      for (const [path, text] of files) {
        writeFileSync(join(OWNER_DATA_DIR, path), text);
      }
      for (const [from, to] of moves) {
        mkdirSync(dirname(join(OWNER_DATA_DIR, to)), { recursive: true });
        renameSync(join(OWNER_DATA_DIR, from), join(OWNER_DATA_DIR, to));
      }
      // The search index is rebuilt from memory/: its old ids go with it.
      for (const f of [
        "index.sqlite",
        "index.sqlite-wal",
        "index.sqlite-shm",
      ]) {
        rmSync(join(LIFE_STATE_DIR, "memory", f), { force: true });
      }
      commitMemory(paths, "Memory: stored names renamed (docs/glossary.md)");
      log("memory.renamed", { files: files.size, moves: moves.length });
      await relabelBoard();
      return true;
    });
    if (!done) {
      await Bun.sleep(5000);
    }
  }
}

/** The board's items name their task on their notes' first line: the new id, so `push` finds them (no second copy). */
async function relabelBoard() {
  if (!isOn("todo_list")) {
    return;
  }
  try {
    const b = backend();
    const { board } = await pull();
    for (const it of board) {
      const task = taskOf(it);
      if (OLD_TASK.test(task)) {
        // biome-ignore lint/performance/noAwaitInLoops: one item at a time
        await b.edit(it.id, {
          notes: (it.notes ?? "").replace(OLD_TASK, "entry_"),
        });
      }
    }
  } catch (e) {
    // The board is Life's projection: a failure leaves a second copy of a receipt, which he can delete.
    log("run.error", {
      error: (e as Error).message,
      step: "memory.renamed.board",
    });
  }
}
