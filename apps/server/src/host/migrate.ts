import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { clock } from "../core/clock";
import { holder } from "../core/lock";
import { log } from "../core/log";
import { mayMigrate, OWNER_DATA_DIR, runsFromRepo } from "../core/paths";
import { locked } from "../memory/memory-lock";
import { observationId } from "../memory/observe";
import { lineHash } from "../memory/page-format";
import { commitMemory } from "../memory/run";
import { reindex } from "../memory/search";

// A rename backfills (AGENTS.md): the observation type `decision` becomes `choice` (his OK, 29 Oct 2026: "decision" is
// now his loops' questions, docs/glossary.md). An observation's id is minted from its type, so each of those is
// minted again and every place that cites it follows. Written once into his data by the app at its next start, under
// the lock, committed in his data repo before and after. Every line keeps its place (the `read_memory_changes` cursor
// and the events' delivery count lines); quotes and what Life read off files keep their words; truth/ and the archive
// are never read. The rewrite is a pure function of the files (`renameStored`), tested on made-up data;
// `migrateStored` reads, writes and commits. The same shape as `stored-names-2026-10-22` (git history), cut to this
// rename.

/** The migrations done, one line each (memory/migrations.jsonl): this one's name. */
const STEP = "observation-choice-2026-10-29";
const DONE = "memory/migrations.jsonl";
/** The renamed memory while it is built, and the old one for the moment of the swap. */
const STAGED = "memory.renamed";
const OLD_MEMORY = "memory.old";
/** A memory/ made between the two renames of the swap (by a writer that never waited): settled like the old copy. */
const STRAY = "memory.stray";
const PATHS = [
  "memory",
  "docs/evals/cases",
  "docs/evals/agent-bench-cases.json",
];

const TYPES: Record<string, string> = { decision: "choice" };
const OBS = /\bobs_[0-9a-f]{12}\b/g;
const STORED = /\.(jsonl|md|json)$/;

/** Keys whose values are someone's words or what Life read off a file: never rewritten, by the files they are in. */
const WORDS: [RegExp, string[]][] = [
  [/^memory\/files\.jsonl$/, ["text", "what"]],
  [/^memory\/units\//, ["title", "summary"]],
  [/^memory\/statements\.jsonl$/, ["text"]],
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

/** Each renamed observation's new id, minted again from its new type (an older recipe's keep theirs). */
function idMap(files: Map<string, string>) {
  const ids = new Map(
    rowsIn(files, "memory/observations")
      .filter(
        (o) =>
          TYPES[o.type] &&
          o.id === observationId(o.unit, o.type, o.quote, o.text)
      )
      .map((o) => [
        o.id as string,
        observationId(o.unit, type(o.type), o.quote, o.text),
      ])
  );
  return (s: string) => s.replace(OBS, (id) => ids.get(id) ?? id);
}

type Rename = ReturnType<typeof idMap>;

function value(
  v: unknown,
  key: string,
  rename: Rename,
  words: Set<string>
): unknown {
  if (typeof v === "string") {
    return words.has(key) ? v : rename(v);
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
  const words = new Set([
    "quote",
    ...WORDS.flatMap(([re, ks]) => (re.test(path) ? ks : [])),
  ]);
  const out = value(r, "", rename, words) as Record<string, unknown>;
  if (TYPED.test(path) && typeof out.type === "string") {
    out.type = type(out.type);
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
 * The rename on the owner data dir's files (path relative to it -> text): the changed files. Pure: every id is renamed
 * the way the code now mints it, so a later reading of the same claim finds the same id.
 */
export function renameStored(files: Map<string, string>) {
  const rename = idMap(files);
  const out = new Map<string, string>();
  for (const [path, text] of files) {
    const next = file(path, text, rename);
    if (next !== text) {
      out.set(path, next);
    }
  }
  return { files: out, rename };
}

const done = (dir: string) =>
  existsSync(join(dir, DONE)) &&
  linesOf(readFileSync(join(dir, DONE), "utf8")).some(
    (l) => JSON.parse(l).name === STEP
  );

/** Is there anything for the rename to do: memory not renamed yet, or a run to finish? */
export const needsRename = (dir = OWNER_DATA_DIR) =>
  [STAGED, OLD_MEMORY, STRAY].some((d) => existsSync(join(dir, d))) ||
  (existsSync(join(dir, "memory")) && !done(dir));

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
  if (statSync(join(dir, folder), { throwIfNoEntry: false })?.isFile()) {
    out.push(folder);
  } else if (existsSync(join(dir, folder))) {
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

const ensureNewline = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);

/**
 * The renamed memory, built whole beside it (memory.renamed/), then swapped in by two renames and settled (`settle`).
 * At a start: a half-built copy with memory/ untouched is built again; a copy built but not swapped in (a crash between
 * the two renames) is swapped in, a memory/ made meanwhile kept aside as a stray; an old copy beside the new memory is
 * settled. Nothing is deleted while an old copy is unsettled.
 */
function renameIn(dir: string) {
  const at = (p: string) => join(dir, p);
  if (existsSync(at(OLD_MEMORY)) && existsSync(at(STAGED))) {
    if (existsSync(at("memory"))) {
      renameSync(at("memory"), at(STRAY));
    }
    renameSync(at(STAGED), at("memory"));
  }
  if (existsSync(at(OLD_MEMORY)) || existsSync(at(STRAY))) {
    return settle(dir);
  }
  rmSync(at(STAGED), { force: true, recursive: true });
  if (dir === OWNER_DATA_DIR && existsSync(at(".git"))) {
    commitMemory(PATHS, "Memory: before the observation type's rename");
  }
  const stored = readStored(dir);
  const { files: renamed } = renameStored(stored);
  const staged = (p: string) => join(dir, STAGED, relative("memory", p));
  // A stored file is staged from the text the rename read (a line written since is carried over by `settle`, renamed);
  // any other file is copied.
  for (const p of filesUnder(dir, "memory")) {
    mkdirSync(dirname(staged(p)), { recursive: true });
    const text = stored.get(p);
    if (text === undefined) {
      copyFileSync(at(p), staged(p));
    } else {
      writeFileSync(staged(p), renamed.get(p) ?? text);
    }
  }
  appendFileSync(
    staged(DONE),
    `${JSON.stringify({ at: clock().toISOString(), name: STEP, schemaVersion: 1 })}\n`
  );
  renameSync(at("memory"), at(OLD_MEMORY));
  renameSync(at(STAGED), at("memory"));
  return settle(dir);
}

/**
 * After the swap, from the old copy (and a stray memory/ made during it): every line of it, renamed, that the new
 * memory lacks is appended to it (a line written meanwhile without the lock: a correction, a rating, a ledger line);
 * every other stored file of it, renamed, replaces the new one where they differ (a page he edited meanwhile). The
 * names come from the old copy, so a settle cut off and run again renames the same way, and adds nothing twice.
 * Then the old copy goes, the regression cases are renamed, and the commit.
 */
function settle(dir: string) {
  const at = (p: string) => join(dir, p);
  const sourceOf = (source: string) =>
    new Map(
      filesUnder(dir, source)
        .map((p) => join("memory", relative(source, p)))
        .filter((p) => STORED.test(p))
        .map(
          (p) =>
            [
              p,
              readFileSync(join(dir, source, relative("memory", p)), "utf8"),
            ] as const
        )
    );
  // The old copy's names (none once it is gone: a settle cut off after it ran again).
  const { rename } = renameStored(
    existsSync(at(OLD_MEMORY)) ? sourceOf(OLD_MEMORY) : new Map()
  );
  // The regression cases first, while the old copy still holds the names they cite.
  for (const [p, text] of readStored(dir)) {
    const next = under(p, "memory") ? text : file(p, text, rename);
    if (next !== text) {
      writeWhole(at(p), next);
    }
  }
  for (const source of [OLD_MEMORY, STRAY].filter((d) => existsSync(at(d)))) {
    carryOver(dir, source, sourceOf(source), rename);
    rmSync(at(source), { force: true, recursive: true });
  }
  if (dir === OWNER_DATA_DIR && existsSync(at(".git"))) {
    commitMemory(PATHS, "Memory: the observation type decision is choice");
  }
  log("memory.renamed", { step: STEP });
}

/**
 * What the new memory lacks of an old copy, renamed: each missing line of a JSON Lines file appended, any other stored
 * file written where it differs (a stray's only where the new memory has none). Run twice, it adds nothing.
 */
function carryOver(
  dir: string,
  source: string,
  old: Map<string, string>,
  rename: Rename
) {
  for (const [p, text] of old) {
    const to = join(dir, p);
    const now = existsSync(to) ? readFileSync(to, "utf8") : "";
    const next = file(p, text, rename);
    if (isJsonl(p)) {
      const have = new Set(linesOf(now));
      const missing = linesOf(next).filter((l) => !have.has(l));
      if (missing.length > 0) {
        writeWhole(to, `${now && ensureNewline(now)}${missing.join("\n")}\n`);
      }
    } else if (next !== now && !(source === STRAY && now)) {
      writeWhole(to, next);
    }
  }
}

/** Another Life's watcher still running (the old app's, or a checkout's): it may write memory/ without the lock. */
const otherWatcher = () => {
  const h = holder("watch");
  return h !== null && h.pid !== String(process.pid);
};

/**
 * Runs the rename once, holding memory's lock, while no other watcher runs: the callers (every command, cli.ts) wait
 * meanwhile. Only the app runs it on his own data (`mayMigrate`): a checkout stops instead.
 */
export async function migrateStored(dir = OWNER_DATA_DIR) {
  // The app's own data: a checkout reaches the rename only on a copy (`mayMigrate`), which no other Life watches.
  const live = !runsFromRepo();
  let said = false;
  while (needsRename(dir)) {
    if (!mayMigrate(dir)) {
      throw new Error(
        'his memory has the observation type "decision": only the new Life.app renames it (AGENTS.md, "A rename backfills")'
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: waits for the process that holds the lock to finish the rename
    const ran = await locked(async () => {
      if (!needsRename(dir)) {
        return true;
      }
      // On the app's data the rename waits for any other watcher (the old app's, a checkout's) to stop.
      if (live && otherWatcher()) {
        if (!said) {
          console.error(
            `the observation type's rename waits for the watcher of ${holder("watch")?.note} to stop`
          );
          said = true;
        }
        return false;
      }
      renameIn(dir);
      // The index is this process's own data's.
      if (dir === OWNER_DATA_DIR) {
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
