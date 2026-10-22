import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { STORES } from "./archive";
import {
  FORMAT,
  filesUnder,
  headOf,
  linesIn,
  type Manifest,
  rowsIn,
  sha256Of,
} from "./export";
import { SETTINGS } from "./settings";
import { ARCHIVE, archiveDb } from "./sources/archived";
import { WATCH } from "./sources/lifelog";
import { DATA, STATE } from "./truth";

// A Life export (`stage`, export.ts) put back: a new install's data, state and archive, checked against its manifest
// before anything is written and counted again after. It never writes over anything: not his data, not an install's
// state, and never into an archive that exists (the only live copy of what was deleted).

/** Where an import goes: this install's folders (a test gives its own). */
export interface Install {
  archive: string;
  data: string;
  state: string;
}
const HERE: Install = { archive: ARCHIVE, data: DATA, state: STATE };

const empty = (dir: string) =>
  !existsSync(dir) || readdirSync(dir).length === 0;
const below = (have: Record<string, number>, want: Record<string, number>) =>
  Object.entries(want)
    .filter(([t, n]) => (have[t] ?? 0) < n)
    .map(([t]) => t);

/** The export's manifest, every file as it lists it (else nothing is changed). */
async function verified(dir: string) {
  const m = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8")
  ) as Manifest;
  if (m.format !== FORMAT) {
    throw new Error(
      `an export of format ${m.format}: this Life reads ${FORMAT}`
    );
  }
  for (const f of m.files) {
    // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed
    if ((await sha256Of(join(dir, f.path))) !== f.sha256) {
      throw new Error(`${f.path} is not as exported: nothing was changed`);
    }
  }
  return m;
}

/** Whether the archive is there already; refuses when it, his data or an install's state would be written over. */
function archiveThere(dir: string, m: Manifest, to: Install) {
  if (!empty(to.data)) {
    throw new Error(`${to.data} is not empty: nothing was changed`);
  }
  const settings = join(to.state, relative(STATE, SETTINGS));
  if (
    existsSync(settings) ||
    existsSync(join(to.state, relative(STATE, WATCH)))
  ) {
    throw new Error(
      `${to.state} holds an install already: nothing was changed`
    );
  }
  const there =
    STORES.map((s) => archiveDb(s.name, to.archive)).filter(existsSync).length >
    0;
  // An archive there is never written to: it must hold everything the export does already.
  for (const p of there ? filesUnder(join(dir, "archive")) : []) {
    const short = p.endsWith(".sqlite")
      ? below(rowsIn(join(to.archive, p)), m.counts.rows[`archive/${p}`] ?? {})
      : [];
    if (short.length > 0) {
      throw new Error(
        `the archive's ${p} has fewer rows than exported (${short.join(", ")}): nothing was changed`
      );
    }
  }
  return there;
}

/** Counts what landed: his data's lines and commit as exported, every store at least its exported rows. */
async function recount(m: Manifest, to: Install) {
  const lines = linesIn(to.data);
  const lost = Object.entries(m.counts.lines).filter(
    ([p, n]) => lines[p] !== n
  );
  if (lost.length > 0 || (await headOf(to.data)) !== m.counts.head) {
    throw new Error(
      `his data is not as exported after the copy (${lost.map(([p]) => p).join(", ") || "its commit"})`
    );
  }
  for (const [p, want] of Object.entries(m.counts.rows)) {
    const at = p.startsWith("archive/")
      ? join(to.archive, relative("archive", p))
      : join(to.state, relative("state", p));
    const short = below(rowsIn(at), want);
    if (short.length > 0) {
      throw new Error(
        `${p} has fewer rows than exported after the copy (${short.join(", ")})`
      );
    }
  }
}

/**
 * Puts the export in `dir` into this install: every file checked against the manifest first, then his data, Life's
 * state and the archive (copied in only where there is none; an existing one must already hold every row the export
 * has), then counted again. Returns what the manifest left out (secrets), for the owner to give by hand.
 */
export async function restore(dir: string, to: Install = HERE) {
  const m = await verified(dir);
  const there = archiveThere(dir, m, to);
  mkdirSync(to.data, { recursive: true });
  cpSync(join(dir, "data"), to.data, { recursive: true });
  mkdirSync(to.state, { recursive: true });
  cpSync(join(dir, "state"), to.state, { recursive: true });
  if (!there) {
    mkdirSync(to.archive, { recursive: true });
    cpSync(join(dir, "archive"), to.archive, { recursive: true });
  }
  await recount(m, to);
  return { files: m.files.length, leftOut: m.leftOut };
}
