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
import { dirname, join, relative, resolve } from "node:path";
import { clock } from "../core/clock";
import { holder } from "../core/lock";
import { log } from "../core/log";
import { isHis, LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { locked } from "../memory/memory-lock";
import { observationId } from "../memory/observe";
import { lineHash } from "../memory/page-format";
import { commitMemory } from "../memory/run";
import { reindex } from "../memory/search";
import { unitId } from "../memory/units";
import { ARCHIVE } from "../sources/archived";
import {
  beeperNetworks,
  dropBeeperSource,
  importBeeper,
} from "./beeper-import";

// A rename backfills (AGENTS.md): Beeper goes (his decision of 30 Oct 2026: Life's own connectors only, no legacy code).
// What it bridged becomes each network's own source: first the archive (`importBeeper`: Beeper's copied messages added
// as new rows to `line.sqlite`, `instagram.sqlite`, `telegram.sqlite`, his OK of new archive files; `beeper.sqlite` is
// only read), then memory: every stored `beeper` source, ref and the ids minted from them become the network's (a unit
// id is minted from its source, an observation's from its unit). Written once into his data by the app at its next
// start, under the lock, committed in his data repo before and after. Every line keeps its place (the
// `read_memory_changes` cursor and the events' delivery count lines); quotes and what Life read off files keep their
// words; truth/ is never read. The rewrite is a pure function of the files and Beeper's maps (`renameStored`), tested
// on made-up data; `migrateStored` reads, writes and commits. The skeleton of `observation-choice-2026-10-29` (git
// history). It goes, with `beeper` in `SourceName`, once it ran on his data.

/** The migrations done, one line each (memory/migrations.jsonl): this one's name. */
const STEP = "beeper-to-networks-2026-10-30";
const DONE = "memory/migrations.jsonl";
/** The renamed memory while it is built, and the old one for the moment of the swap. */
const STAGED = "memory.renamed";
const OLD_MEMORY = "memory.old";
/** A memory/ made between the two renames of the swap (by a writer that never waited): settled like the old copy. */
const STRAY = "memory.stray";
const PATHS = ["memory", "docs/evals"];
/** An old copy on its way out, once everything in it was carried over: removed at the next start if a crash left it. */
const GONE = "memory.gone";

/** Does this code run from a repo (a checkout or a worktree) rather than from Life.app's resources? */
const runsFromRepo = () => existsSync(join(LIFE_CODE_DIR, ".git"));
/** Only the running app migrates his own data: a checkout or worktree may migrate a copy, never his live data. */
const mayMigrate = (data: string) => !(runsFromRepo() && isHis(data));
/** The live archive is written only for his own data: a run on a copy imports into a copied archive, or not at all. */
const mayImport = (data: string, archive: string) =>
  isHis(data) || resolve(archive) !== resolve(ARCHIVE);

const IDS = /\b(?:unit|obs)_[0-9a-f]{12}\b/g;
/** A `beeper:` ref: a chat's message (`beeper:!<room>/<message>`) or a file (`beeper:<mxc url>`, `beeper:localmxc://…`). */
const REF = /\bbeeper:(?:(![^\s"/]+)(\/[^\s"]*)?|([^\s"]+))/g;
const STORED = /\.(jsonl|md|json)$/;

/** Keys whose values are someone's words or what Life read off a file: never rewritten, by the files they are in. */
const WORDS: [RegExp, string[]][] = [
  [/^memory\/files\.jsonl$/, ["text", "what"]],
  [/^memory\/units\//, ["title", "summary"]],
  [/^memory\/statements\.jsonl$/, ["text"]],
];

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
const linesOf = (text: string) => text.split("\n").filter((l) => l.trim());

/** Every record in the JSON Lines files at or under `path`. */
// biome-ignore lint/suspicious/noExplicitAny: records of every kind, read before any schema knows the new names
const rowsIn = (files: Map<string, string>, path: string): any[] =>
  [...files]
    .filter(([p]) => (p === path || under(p, path)) && isJsonl(p))
    .flatMap(([p, text]) => linesOf(text).map((l, i) => parsed(p, l, i)));

/** Which network each of Beeper's chats and files was, from its archive: the rename's only facts. */
export interface Networks {
  /** By chat id. */
  chats: Map<string, string>;
  /** By attachment id (an `mxc://` URL). */
  files: Map<string, string>;
}

/** A chat's network: Beeper knew it, or an `imsg##` one (iMessage, when Beeper bridged it). */
const chatNet = (nets: Networks, chat: string) =>
  nets.chats.get(chat) ?? (chat.startsWith("imsg##") ? "imessage" : undefined);

/**
 * A `beeper:` ref as its network's: a chat's message (`beeper:<chat>/<msg>`) or a file (`beeper:<mxc>`); a chat
 * Beeper never knew takes its record's network (`fallback`).
 */
function refOf(
  nets: Networks,
  rest: string,
  msg: string | undefined,
  fallback?: string
) {
  const known =
    msg === undefined
      ? (nets.files.get(rest) ?? chatNet(nets, rest))
      : chatNet(nets, rest);
  const net = known ?? fallback;
  if (!net) {
    throw new Error(
      `beeper:${rest}: no network known for it in Beeper's archive`
    );
  }
  return `${net}:${rest}${msg ?? ""}`;
}

/**
 * The rename's facts from the files: each renamed unit's and observation's new id, minted again from its network (an
 * older recipe's keep theirs), and each Beeper unit's network (what a record with no known chat is about).
 */
function idMap(files: Map<string, string>, nets: Networks) {
  const units = new Map<string, string>();
  const unitNets = new Map<string, string>();
  for (const u of rowsIn(files, "memory/units")) {
    const net = u.source === "beeper" ? nets.chats.get(u.key) : undefined;
    if (net) {
      unitNets.set(u.id, net);
    }
    if (net && u.id === unitId("beeper", u.key, u.date)) {
      units.set(u.id, unitId(net, u.key, u.date));
    }
  }
  const ids = new Map(units);
  for (const o of rowsIn(files, "memory/observations")) {
    const unit = units.get(o.unit);
    if (unit && o.id === observationId(o.unit, o.type, o.quote, o.text)) {
      ids.set(o.id, observationId(unit, o.type, o.quote, o.text));
    }
  }
  const rename = (s: string, fallback?: string) =>
    s
      .replace(IDS, (id) => ids.get(id) ?? id)
      .replace(REF, (_, room?: string, msg?: string, other?: string) =>
        refOf(
          nets,
          room ?? other ?? "",
          room ? (msg ?? "") : undefined,
          fallback
        )
      );
  return Object.assign(rename, { unitNets });
}

type Rename = ReturnType<typeof idMap>;

function value(
  v: unknown,
  key: string,
  rename: (s: string) => string,
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

/** The network a record is about: its chat (`key`), a `beeper:` ref Beeper's archive knows, else its unit's. */
function networkOf(r: Record<string, unknown>, nets: Networks, rename: Rename) {
  const chat = typeof r.key === "string" ? nets.chats.get(r.key) : undefined;
  const refs = [...JSON.stringify(r).matchAll(new RegExp(REF.source, "g"))].map(
    (m) => m[1] ?? m[3] ?? ""
  );
  const byRef = refs
    .map((x) => chatNet(nets, x) ?? nets.files.get(x))
    .find(Boolean);
  const unitIds = [r.unit, ...(Array.isArray(r.units) ? r.units : [])].filter(
    (u): u is string => typeof u === "string"
  );
  const byUnit = unitIds.map((u) => rename.unitNets.get(u)).find(Boolean);
  const net = chat ?? byRef ?? byUnit;
  if (!net) {
    throw new Error(
      "a record of source beeper with no chat, ref or unit Beeper's archive knows"
    );
  }
  return net;
}

function row(
  path: string,
  r: Record<string, unknown>,
  rename: Rename,
  nets: Networks
) {
  const words = new Set([
    "quote",
    ...WORDS.flatMap(([re, ks]) => (re.test(path) ? ks : [])),
  ]);
  // The source named as a field, before its refs are renamed (they say which network).
  const source = r.source as unknown;
  const isBeeper =
    source === "beeper" ||
    (source as { channel?: string } | undefined)?.channel === "beeper";
  // Any record citing Beeper takes its network for a ref whose chat Beeper's archive never held.
  const net =
    isBeeper || JSON.stringify(r).includes("beeper:")
      ? networkOf(r, nets, rename)
      : undefined;
  const out = value(r, "", (x) => rename(x, net), words) as Record<
    string,
    unknown
  >;
  if (isBeeper && out.source === "beeper") {
    out.source = net;
  } else if (isBeeper) {
    out.source = { ...(out.source as object), channel: net };
  }
  return out;
}

const jsonl = (path: string, text: string, rename: Rename, nets: Networks) =>
  text
    .split("\n")
    .map((l) => {
      if (!l.trim()) {
        return l;
      }
      const was = parsed(path, l, 0) as Record<string, unknown>;
      const now = JSON.stringify(row(path, was, rename, nets));
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
      cites.map((c) => rename(c)),
    ])
  );
  return lines
    .map((l, i) => (i === at ? `lines: ${JSON.stringify(next)}` : rename(l)))
    .join("\n");
}

function file(path: string, text: string, rename: Rename, nets: Networks) {
  if (isJsonl(path)) {
    return jsonl(path, text, rename, nets);
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
export function renameStored(files: Map<string, string>, nets: Networks) {
  const rename = idMap(files, nets);
  const out = new Map<string, string>();
  for (const [path, text] of files) {
    const next = file(path, text, rename, nets);
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
  [STAGED, OLD_MEMORY, STRAY, GONE].some((d) => existsSync(join(dir, d))) ||
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
function renameIn(dir: string, archive: string) {
  const at = (p: string) => join(dir, p);
  if (existsSync(at(OLD_MEMORY)) && existsSync(at(STAGED))) {
    if (existsSync(at("memory"))) {
      renameSync(at("memory"), at(STRAY));
    }
    renameSync(at(STAGED), at("memory"));
  }
  if (existsSync(at(OLD_MEMORY)) || existsSync(at(STRAY))) {
    return settle(dir, archive);
  }
  rmSync(at(STAGED), { force: true, recursive: true });
  if (dir === OWNER_DATA_DIR && existsSync(at(".git"))) {
    commitMemory(PATHS, "Memory: before Beeper's names become their networks'");
  }
  // The archive first: memory's new refs point at rows that are there already.
  if (mayImport(dir, archive)) {
    importBeeper(archive);
  }
  // His settings only for his own data: a copy's run leaves them alone.
  if (dir === OWNER_DATA_DIR) {
    dropBeeperSource();
  }
  const nets = beeperNetworks(archive);
  const stored = readStored(dir);
  const { files: renamed } = renameStored(stored, nets);
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
  return settle(dir, archive);
}

/**
 * After the swap, from the old copy (and a stray memory/ made during it): every line of it, renamed, that the new
 * memory lacks is appended to it (a line written meanwhile without the lock: a correction, a rating, a ledger line);
 * every other stored file of it, renamed, replaces the new one where they differ (a page he edited meanwhile). The
 * names come from the old copy, so a settle cut off and run again renames the same way, and adds nothing twice.
 * Then the old copy goes, the regression cases are renamed, and the commit.
 */
function settle(dir: string, archive: string) {
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
  const nets = beeperNetworks(archive);
  const { rename } = renameStored(
    existsSync(at(OLD_MEMORY)) ? sourceOf(OLD_MEMORY) : new Map(),
    nets
  );
  // The regression cases first, while the old copy still holds the names they cite.
  for (const [p, text] of readStored(dir)) {
    const next = under(p, "memory") ? text : file(p, text, rename, nets);
    if (next !== text) {
      writeWhole(at(p), next);
    }
  }
  // Every copy carried over while the old one still holds the names; only then each goes, the stray first and the old
  // copy last (it holds the names), each by one rename first, so a crash never leaves half a copy to settle from.
  const sources = [OLD_MEMORY, STRAY].filter((d) => existsSync(at(d)));
  for (const source of sources) {
    carryOver(dir, source, sourceOf(source), rename, nets);
  }
  for (const source of sources.toReversed()) {
    rmSync(at(GONE), { force: true, recursive: true });
    renameSync(at(source), at(GONE));
    rmSync(at(GONE), { force: true, recursive: true });
  }
  if (dir === OWNER_DATA_DIR && existsSync(at(".git"))) {
    commitMemory(
      PATHS,
      "Memory: Beeper's names are their networks' (LINE, Instagram, Telegram)"
    );
  }
  log("run.end", { step: `memory.migrate.${STEP}` });
}

/**
 * What the new memory lacks of an old copy, renamed: each missing line of a JSON Lines file appended, any other stored
 * file written where it differs (a stray's only where the new memory has none). Run twice, it adds nothing.
 */
function carryOver(
  dir: string,
  source: string,
  old: Map<string, string>,
  rename: Rename,
  nets: Networks
) {
  for (const [p, text] of old) {
    const to = join(dir, p);
    const now = existsSync(to) ? readFileSync(to, "utf8") : "";
    const next = file(p, text, rename, nets);
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
export async function migrateStored(dir = OWNER_DATA_DIR, archive = ARCHIVE) {
  // The app's own data: a checkout reaches the rename only on a copy (`mayMigrate`), which no other Life watches.
  const live = !runsFromRepo();
  let said = false;
  while (needsRename(dir)) {
    if (!mayMigrate(dir)) {
      throw new Error(
        'his memory still names Beeper: only the new Life.app renames it (AGENTS.md, "A rename backfills")'
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: waits for the process that holds the lock to finish the rename
    const ran = await locked(async () => {
      // A copy a crash left on its way out: everything in it was carried over already.
      rmSync(join(dir, GONE), { force: true, recursive: true });
      if (!needsRename(dir)) {
        return true;
      }
      // On the app's data the rename waits for any other watcher (the old app's, a checkout's) to stop.
      if (live && otherWatcher()) {
        if (!said) {
          console.error(
            `Beeper's rename waits for the watcher of ${holder("watch")?.note} to stop`
          );
          said = true;
        }
        return false;
      }
      renameIn(dir, archive);
      // The index is this process's own data's.
      if (dir === OWNER_DATA_DIR) {
        await reindex().catch((e) =>
          log("run.error", {
            error: (e as Error).message,
            step: `memory.migrate.${STEP}.index`,
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
