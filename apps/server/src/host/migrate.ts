import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { clock } from "../core/clock";
import { log } from "../core/log";
import { isOn } from "../core/outputs";
import { mayMigrate, OWNER_DATA_DIR } from "../core/paths";
import { locked } from "../memory/memory-lock";
import { momentId } from "../memory/moments";
import { observationId } from "../memory/observe";
import { lineHash } from "../memory/page-format";
import { commitMemory } from "../memory/run";
import { reindex } from "../memory/search";
import { unitId } from "../memory/units";
import { backend, pull } from "../todo-list/backend";
import { taskOf } from "../todo-list/board";
import { entryId } from "./act";

// A rename backfills (AGENTS.md): the stored names the owner chose on 22 Oct 2026 (docs/glossary.md), written once
// into his data by the app at its next start, under the lock, committed in his data repo before and after. Every line
// keeps its place (the `changes` cursor and the events' delivery count lines); quotes and what Life read off files
// keep their words; truth/ and the archive are never read. The rewrite is a pure function of the files
// (`renameStored`), tested on made-up data; `migrateStored` reads, writes and commits. The settings file is renamed
// where it is read (`renamedSettings`, core/settings.ts).

/** The migrations done, one line each (memory/migrations.jsonl): this one's name. */
const STEP = "stored-names-2026-10-22";
const DONE = "memory/migrations.jsonl";
/** The renamed memory while it is built, and the old one for the moment of the swap. */
const STAGED = "memory.renamed";
const OLD_MEMORY = "memory.old";
/** How much of each file the rename read, kept until the old copy is settled. */
const READ = "memory.read.json";
const OLD_LEDGER = "memory/actions.jsonl";
const NEW_LEDGER = "memory/ledger.jsonl";
const PATHS = ["memory", "docs/evals/cases"];

const TYPES: Record<string, string> = {
  person: "about_a_person",
  todo: "to_do",
  waiting: "waiting_on_someone",
};
const OLD_AGENT = "atlas";
const NEW_AGENT = "agent";
const ID = /\b(u|act|obs|mom)_([0-9a-f]{12})\b/g;
const INFERRED = /\bperson:inf-/g;
const AGENT_REF = /^(unknown:|agent:)?atlas(?=$|:)/;
const INFERRED_ID = /^inf-/;
const INFERRED_PAGE = /^(memory\/pages\/people\/)inf-/;
const OLD_TASK_LINE = /^act_[0-9a-f]{12}(?=\n|$)/;
const STORED = /\.(jsonl|md|json)$/;

/** Keys whose values are someone's words or what Life read off a file: never rewritten, by the files they are in. */
const WORDS: [RegExp, string[]][] = [
  [/^memory\/files\.jsonl$/, ["text", "what"]],
  [/^memory\/units\//, ["title", "summary"]],
  [/^memory\/statements\.jsonl$/, ["text"]],
];
/** Keys where the agent's old word is a stored value: a source, a target, a sender, a ref or a speaker. */
const AGENT_KEYS = new Set([
  "channel",
  "ref",
  "refs",
  "sender",
  "source",
  "speaker",
  "speakerFrom",
  "target",
]);
/** The keys each file renames: `[old, new]` at the top of each line. */
const KEYS: [RegExp, [string, string][]][] = [
  [/^memory\/verdicts\.jsonl$/, [["salience", "importance"]]],
  [/^memory\/observations\//, [["salience", "importance"]]],
  [/^memory\/actions\.jsonl$/, [["madeBy", "via"]]],
  [/^memory\/(statements|ratings)\.jsonl$/, [["claim", "ref"]]],
];
/** The files whose `type` is an observation's type. */
const TYPED = /^memory\/(verdicts\.jsonl|labels\.jsonl|observations\/)/;

const isJsonl = (path: string) => path.endsWith(".jsonl");
/** A line of a stored file, or an error that names the file and the line. */
function parsed(path: string, line: string, i: number) {
  try {
    return JSON.parse(line);
  } catch (e) {
    throw new Error(
      `${path}, line ${i + 1}: not JSON, so its names can't be renamed`,
      { cause: e }
    );
  }
}
const under = (path: string, dir: string) => path.startsWith(`${dir}/`);
const type = (t: string) => TYPES[t] ?? t;
const linesOf = (text: string) => text.split("\n").filter((l) => l.trim());

/** Every record in the JSON Lines files at or under `path`. */
// biome-ignore lint/suspicious/noExplicitAny: records of every kind, read before any schema knows the new names
const rowsIn = (files: Map<string, string>, path: string): any[] =>
  [...files]
    .filter(([p]) => (p === path || under(p, path)) && isJsonl(p))
    .flatMap(([p, text]) => linesOf(text).map((l, i) => parsed(p, l, i)));

/** The old unit recipe: the same parts as `unitId`, the old prefix. */
const oldUnitId = (...parts: string[]) => `u_${unitId(...parts).slice(5)}`;
const oldEntryId = (ref: string, kind: string, title: string) =>
  `act_${entryId(ref, kind, title).slice(6)}`;
const entry = (hex: string) => `entry_${hex}`;

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
          String(u.key).replace(ID, (_, __, h) => entry(h)),
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

/**
 * Ledger entries minted from an id: an add from an observation (a grant's quote), a split from its parent ask. Minted
 * again from the new id, so the same words still act or ask once; the rest only change their prefix.
 */
function entryIds(
  files: Map<string, string>,
  rename: (s: string) => string,
  ids: Map<string, string>
) {
  // In file order, so a split's parent (itself maybe a split) has its new id before it.
  for (const a of rowsIn(files, OLD_LEDGER)) {
    const ref = String(a.after?.parent ?? a.instruction?.ref ?? "");
    const title = [String(a.after?.title ?? ""), `${a.after?.on}`].find(
      (t) => ref && a.id === oldEntryId(ref, a.kind, t)
    );
    if (title !== undefined && !ids.has(a.id)) {
      ids.set(a.id, entryId(rename(ref), a.kind, title));
    }
  }
}

/** Each old id's new one: minted again where an id is minted from another, else the new prefix. */
function idMaps(files: Map<string, string>) {
  const agents = agentUnits(files);
  const unit = (id: string) =>
    id.startsWith("u_") ? (agents.get(id) ?? `unit_${id.slice(2)}`) : id;
  const observations = observationIds(files, unit);
  const moments = momentIds(files, unit);
  const ids = (known: Map<string, string>) => (s: string) =>
    s
      .replace(ID, (id, p, hex) => {
        if (p === "u") {
          return unit(id);
        }
        if (p === "obs") {
          return observations.get(id) ?? id;
        }
        if (p === "mom") {
          return moments.get(id) ?? id;
        }
        return known.get(id) ?? entry(hex);
      })
      .replace(INFERRED, "person:inf_");
  const entries = new Map<string, string>();
  const rename = ids(entries);
  entryIds(files, rename, entries);
  return rename;
}

type Rename = ReturnType<typeof idMaps>;

/** The agent's old word as a stored value (a source, a target, a ref's or a speaker's prefix), never in prose. */
const agentWord = (s: string) =>
  s.replace(AGENT_REF, (_, before) => `${before ?? ""}${NEW_AGENT}`);

function value(
  v: unknown,
  key: string,
  rename: Rename,
  words: Set<string>
): unknown {
  if (typeof v === "string") {
    if (words.has(key)) {
      return v;
    }
    const s = rename(v);
    return AGENT_KEYS.has(key) ? agentWord(s) : s;
  }
  if (Array.isArray(v)) {
    return v.map((x) => value(x, key, rename, words));
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, value(x, k, rename, words)])
    );
  }
  return v;
}

function row(path: string, r: Record<string, unknown>, rename: Rename) {
  const keys = new Map(KEYS.flatMap(([re, ks]) => (re.test(path) ? ks : [])));
  const words = new Set([
    "quote",
    ...WORDS.flatMap(([re, ks]) => (re.test(path) ? ks : [])),
  ]);
  const out = Object.fromEntries(
    Object.entries(r).map(([k, v]) => [
      keys.get(k) ?? k,
      value(v, k, rename, words),
    ])
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

const jsonl = (path: string, text: string, rename: Rename) =>
  text
    .split("\n")
    .map((l) => {
      if (!l.trim()) {
        return l;
      }
      const was = parsed(path, l, 0) as Record<string, unknown>;
      const now = JSON.stringify(row(path, was, rename));
      return now === JSON.stringify(was) ? l : now;
    })
    .join("\n");

/** A page: ids renamed in it, and its generated lines' hashes moved to the lines as they now read. */
function page(text: string, rename: Rename) {
  const lines = text.split("\n");
  const front = lines.findIndex((l, i) => i > 0 && l === "---");
  const at = lines.findIndex((l, i) => i < front && l.startsWith("lines: "));
  if (front < 0 || at < 0) {
    return rename(text);
  }
  const hashes = JSON.parse(lines[at]?.slice(7) ?? "{}") as Record<
    string,
    string[]
  >;
  const moved = new Map(
    lines
      .slice(front + 1)
      .map((l) => [lineHash(l), lineHash(rename(l))] as const)
  );
  const next = Object.fromEntries(
    Object.entries(hashes).map(([h, cites]) => [
      moved.get(h) ?? h,
      cites.map(rename),
    ])
  );
  return lines
    .map((l, i) => (i === at ? `lines: ${JSON.stringify(next)}` : rename(l)))
    .join("\n");
}

function file(path: string, text: string, rename: Rename) {
  if (isJsonl(path)) {
    return jsonl(path, text, rename);
  }
  if (path.endsWith(".md")) {
    return under(path, "memory/pages") ? page(text, rename) : text;
  }
  const was = JSON.parse(text);
  const now = value(was, "", rename, new Set(["quote"]));
  return JSON.stringify(now) === JSON.stringify(was)
    ? text
    : `${JSON.stringify(now, null, 2)}\n`;
}

/**
 * The rename on the owner data dir's files (path relative to it -> text): the changed files and the files to move.
 * Pure: every id is renamed the way the code now mints it, so a later reading of the same unit, moment, claim or
 * words finds the same id.
 */
export function renameStored(files: Map<string, string>) {
  const rename = idMaps(files);
  const out = new Map<string, string>();
  const moves: [string, string][] = [];
  for (const [path, text] of files) {
    const next = file(path, text, rename);
    if (next !== text) {
      out.set(path, next);
    }
    const moved =
      path === OLD_LEDGER ? NEW_LEDGER : path.replace(INFERRED_PAGE, "$1inf_");
    if (moved !== path) {
      moves.push([path, moved]);
    }
  }
  return { files: out, moves, rename };
}

/** The stored files of one data dir, by their path in it. */
const done = (dir: string) =>
  existsSync(join(dir, DONE)) &&
  linesOf(readFileSync(join(dir, DONE), "utf8")).some(
    (l) => JSON.parse(l).name === STEP
  );

/** Is there anything for the rename to do: memory not renamed yet, a run to finish, or the old ledger written again? */
export const needsRename = (dir = OWNER_DATA_DIR) =>
  existsSync(join(dir, STAGED)) ||
  existsSync(join(dir, OLD_MEMORY)) ||
  (existsSync(join(dir, "memory")) &&
    (!done(dir) || existsSync(join(dir, OLD_LEDGER))));

/** Every file under `folder`, by its path relative to `dir`. */
function filesUnder(dir: string, folder: string) {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const p = join(at, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        out.push(relative(dir, p));
      }
    }
  };
  if (existsSync(join(dir, folder))) {
    walk(join(dir, folder));
  }
  return out;
}

/** The stored files the rename reads: memory/ (JSON Lines and pages) and the regression cases. */
const readStored = (dir: string) =>
  new Map(
    PATHS.flatMap((p) => filesUnder(dir, p))
      .filter((p) => STORED.test(p))
      .map((p) => [p, readFileSync(join(dir, p), "utf8")])
  );

/** Writes a file whole: a reader never meets half of it. */
function writeWhole(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.${process.pid}.tmp`, text);
  renameSync(`${path}.${process.pid}.tmp`, path);
}

/**
 * The renamed memory, built whole beside it (memory.renamed/: every file copied, the renamed ones written, the moved
 * ones moved), then swapped in by two renames and settled (`settle`). A run cut off before the swap leaves memory/ as
 * it was (the half-built copy is dropped and built again); one cut off after it is settled at the next start.
 */
function renameIn(dir: string) {
  const at = (p: string) => join(dir, p);
  if (existsSync(at(STAGED)) && !existsSync(at("memory"))) {
    renameSync(at(STAGED), at("memory"));
  }
  if (existsSync(at(OLD_MEMORY))) {
    return settle(dir);
  }
  rmSync(at(STAGED), { force: true, recursive: true });
  if (dir === OWNER_DATA_DIR && existsSync(at(".git"))) {
    commitMemory(PATHS, "Memory: before the stored names' rename");
  }
  const files = readStored(dir);
  const { files: renamed, moves } = renameStored(files);
  const staged = (p: string) => join(dir, STAGED, relative("memory", p));
  for (const p of filesUnder(dir, "memory")) {
    mkdirSync(dirname(staged(p)), { recursive: true });
    copyFileSync(at(p), staged(p));
  }
  for (const [p, text] of renamed) {
    if (under(p, "memory")) {
      writeFileSync(staged(p), text);
    }
  }
  for (const [from, to] of moves) {
    renameSync(staged(from), staged(to));
  }
  appendFileSync(
    staged(DONE),
    `${JSON.stringify({ at: clock().toISOString(), name: STEP, schemaVersion: 1 })}\n`
  );
  // How much of each file was read: what an old process appends after it is a late line (`settle`).
  writeFileSync(
    at(READ),
    JSON.stringify(
      Object.fromEntries([...files].map(([p, t]) => [p, t.length]))
    )
  );
  renameSync(at("memory"), at(OLD_MEMORY));
  renameSync(at(STAGED), at("memory"));
  return settle(dir);
}

/**
 * After the swap: the lines appended to the old memory past what was read (a correction, a rating, an old process's
 * ledger line, all written without the lock) renamed onto the new one, the old copy gone, the regression cases
 * renamed, and the commit. The names are read off the old copy, so a settle at a later start renames the same way.
 */
function settle(dir: string) {
  const at = (p: string) => join(dir, p);
  const old = (p: string) => join(dir, OLD_MEMORY, relative("memory", p));
  const read = JSON.parse(readFileSync(at(READ), "utf8")) as Record<
    string,
    number
  >;
  const files = new Map([
    ...filesUnder(dir, OLD_MEMORY)
      .map((p) => join("memory", relative(OLD_MEMORY, p)))
      .filter((p) => STORED.test(p))
      .map((p) => [p, readFileSync(old(p), "utf8")] as const),
    ...[...readStored(dir)].filter(([p]) => !under(p, "memory")),
  ]);
  // A file not read at all was made after the read: all of it is late.
  const {
    files: renamed,
    moves,
    rename,
  } = renameStored(
    new Map([...files].map(([p, t]) => [p, t.slice(0, read[p] ?? 0)]))
  );
  for (const [p, text] of files) {
    const late = text.slice(read[p] ?? 0);
    if (isJsonl(p) && late.trim()) {
      const to = moves.find(([from]) => from === p)?.[1] ?? p;
      appendFileSync(at(to), ensureNewline(jsonl(p, late, rename)));
    }
  }
  for (const [p, text] of renamed) {
    if (!under(p, "memory")) {
      writeWhole(at(p), text);
    }
  }
  rmSync(at(OLD_MEMORY), { force: true, recursive: true });
  rmSync(at(READ), { force: true });
  if (dir === OWNER_DATA_DIR && existsSync(at(".git"))) {
    commitMemory(PATHS, "Memory: stored names renamed (docs/glossary.md)");
  }
  log("memory.renamed", { files: renamed.size, moves: moves.length });
  return rename;
}

const ensureNewline = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);

/** Lines appended to the old ledger after the rename (by a process still on the old code): renamed onto the new one. */
function lateLines(dir: string) {
  const at = (p: string) => join(dir, p);
  // Taken whole first: a line appended meanwhile starts a new file, renamed at the next start.
  const taken = `${OLD_LEDGER}.${process.pid}`;
  renameSync(at(OLD_LEDGER), at(taken));
  const text = readFileSync(at(taken), "utf8");
  const files = new Map([...readStored(dir), [OLD_LEDGER, text]]);
  appendFileSync(
    at(NEW_LEDGER),
    ensureNewline(jsonl(OLD_LEDGER, text, renameStored(files).rename))
  );
  rmSync(at(taken));
  log("memory.renamed", { late: linesOf(text).length });
}

/**
 * Runs the rename once, holding memory's lock: the callers (every command, cli.ts) wait while another process runs
 * it. Only the app runs it on his own data (`mayMigrate`): a checkout stops instead.
 */
export async function migrateStored(dir = OWNER_DATA_DIR) {
  while (needsRename(dir)) {
    if (!mayMigrate(dir)) {
      throw new Error(
        'his memory has the names from before 22 Oct 2026: only the new Life.app renames them (AGENTS.md, "A rename backfills")'
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: waits for the process that holds the lock to finish the rename
    const ran = await locked(async () => {
      if (done(dir) && existsSync(join(dir, OLD_LEDGER))) {
        lateLines(dir);
        return true;
      }
      if (!needsRename(dir)) {
        return true;
      }
      const rename = renameIn(dir);
      // The board and the index are his live data's.
      if (dir === OWNER_DATA_DIR) {
        await relabelBoard(rename);
        await reindex().catch((e) =>
          log("run.error", {
            error: (e as Error).message,
            step: "memory.renamed.index",
          })
        );
      }
      return true;
    });
    if (!ran) {
      await Bun.sleep(5000);
    }
  }
}

/** A board item's notes with its task's new id on their first line (the rest is his words, untouched). */
export const relabeled = (notes: string, rename: (s: string) => string) =>
  notes.replace(OLD_TASK_LINE, (id) => rename(id));

/** The board's items name their task on their notes' first line: the new id, so `push` finds them (no second copy). */
async function relabelBoard(rename: (s: string) => string) {
  if (!isOn("todo_list")) {
    return;
  }
  try {
    const b = backend();
    const { board } = await pull();
    for (const it of board) {
      if (OLD_TASK_LINE.test(taskOf(it))) {
        // biome-ignore lint/performance/noAwaitInLoops: one item at a time
        await b.edit(it.id, { notes: relabeled(it.notes ?? "", rename) });
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
