import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { sha256Of } from "../core/hash";
import { DESK_STORE, LIFE_STATE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { SETTINGS } from "../core/settings";
import { ARCHIVED } from "../memory/sources";
import { ARCHIVE, archiveDb } from "../sources/archived";
import { storeFiles } from "../sources/voice-server";
import { notesOutsideOf } from "./desk-read";
import {
  FORMAT,
  headOf,
  linesIn,
  type Manifest,
  pathIn,
  rowsIn,
} from "./export";
import { isEmpty } from "./init";

// A Life export (`stage`, export.ts) put back: a new install's data, state and archive, and the desk's notes files at the
// paths its store names (refused over a different file there). All or nothing: refused at
// once over anything there (his data, an install's state, an archive short of the export's rows: the archive is never
// written to), every listed file checked, copied beside its place and counted, then moved in, his data last: his data
// there means a whole install (`started`). Files the manifest doesn't list are never copied. The manifest itself is
// trusted: this guards against a corrupt or changed copy, not someone forging both.

/** Where an import goes: this install's folders (a test gives its own). */
export interface Install {
  archive: string;
  data: string;
  state: string;
}
const HERE: Install = {
  archive: ARCHIVE,
  data: OWNER_DATA_DIR,
  state: LIFE_STATE_DIR,
};
type Part = keyof Install;
const PARTS: Part[] = ["state", "archive", "data"];

const short = (
  have: Record<string, number>,
  want: Record<string, number>,
  exact: boolean
) =>
  Object.entries(want)
    .filter(([t, n]) => (exact ? have[t] !== n : (have[t] ?? 0) < n))
    .map(([t]) => t);
/** A manifest path's part (`data/x` is data's `x`; `notes/<asg>.md` a desk notes file), and the path inside it; one that leaves its part is refused. */
const partOf = (p: string) => {
  const [part, ...rest] = p.split("/");
  if (
    !(PARTS.includes(part as Part) || part === "notes") ||
    rest.includes("..")
  ) {
    throw new Error(`${p} is no path of an export: nothing was changed`);
  }
  return { part: part as Part | "notes", path: rest.join("/") };
};

/**
 * Where each desk notes file of the export (`dir`) goes, as its staged store (`store`, verified) names it, outside the
 * state folder it goes to (`state`): refused when a note names no such assignment, or a different file is there
 * already; one there with the same bytes is still listed, so `putNotes` finds it again.
 */
async function notesPlacesOf(
  dir: string,
  m: Manifest,
  store: string,
  state: string
) {
  const names = m.files.filter((f) => partOf(f.path).part === "notes");
  if (names.length === 0) {
    return [];
  }
  const at = new Map(
    existsSync(store)
      ? notesOutsideOf(store, state).map((s) => [s.id, s.notes_path])
      : []
  );
  const places: { from: string; sha256: string; to: string }[] = [];
  for (const f of names) {
    const to = at.get(basename(f.path, ".md"));
    if (!to) {
      throw new Error(
        `${f.path} is no assignment's notes outside ${state}: nothing was changed`
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed
    if (existsSync(to) && (await sha256Of(to)) !== f.sha256) {
      throw new Error(`${to} holds other notes: nothing was changed`);
    }
    places.push({ from: join(dir, f.path), sha256: f.sha256, to });
  }
  return places;
}

/**
 * Puts each note in place, never over another file: made only where nothing is (`COPYFILE_EXCL`), one there with the
 * same bytes kept as it is. Any failure (another writer's note there meanwhile, a folder it cannot make, a read that
 * fails) refuses the import and takes back the notes this call made, but only those still holding its bytes: a note
 * someone edited since is theirs, and stays.
 */
// ponytail: a note edited between its hash and its removal is lost; a rename aside, then a check, if that bites.
export async function putNotes(
  places: readonly { from: string; sha256: string; to: string }[]
) {
  const made: (typeof places)[number][] = [];
  try {
    for (const n of places) {
      mkdirSync(dirname(n.to), { recursive: true });
      try {
        copyFileSync(n.from, n.to, constants.COPYFILE_EXCL);
        made.push(n);
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") {
          throw e;
        }
        // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed
        if ((await sha256Of(n.to)) !== n.sha256) {
          throw new Error(`${n.to} holds other notes: nothing was changed`, {
            cause: e,
          });
        }
      }
    }
  } catch (e) {
    for (const n of made) {
      // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed
      if ((await sha256Of(n.to).catch(() => null)) === n.sha256) {
        rmSync(n.to, { force: true });
      }
    }
    throw e;
  }
}

/**
 * Refuses at once when the import would write over something; whether the archive is there already (then kept, never
 * written to). A state file left by an earlier try that failed while moving in passes when it is the export's own.
 */
async function refusal(m: Manifest, to: Install) {
  if (m.format !== FORMAT) {
    throw new Error(
      `an export of format ${m.format}: this Life reads ${FORMAT}`
    );
  }
  if (!isEmpty(to.data)) {
    throw new Error(`${to.data} is not empty: nothing was changed`);
  }
  const listed = new Map(m.files.map((f) => [f.path, f.sha256]));
  // A state file is never written over: one there that is not the export's own refuses the import, and so does any
  // of an install's marks (its settings, the watcher's store and cursor) even when the export has none.
  const marks = [SETTINGS, ...Object.values(storeFiles())].map(
    (p) => `state/${pathIn(LIFE_STATE_DIR, p)}`
  );
  const states = new Set([
    ...marks,
    ...m.files.map((f) => f.path).filter((p) => p.startsWith("state/")),
  ]);
  for (const p of states) {
    const at = join(to.state, p.slice("state/".length));
    // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed
    if (existsSync(at) && (await sha256Of(at)) !== listed.get(p)) {
      throw new Error(`${at} holds another file: nothing was changed`);
    }
  }
  const there = ARCHIVED.some((s) => existsSync(archiveDb(s.name, to.archive)));
  if (!(there || isEmpty(to.archive))) {
    throw new Error(
      `${to.archive} holds files but no store: nothing was changed`
    );
  }
  for (const [p, want] of there ? Object.entries(m.counts.rows) : []) {
    const { part, path } = partOf(p);
    const less =
      part === "archive"
        ? short(rowsIn(join(to.archive, path)), want, false)
        : [];
    if (less.length > 0) {
      throw new Error(
        `the archive's ${path} has fewer rows than exported (${less.join(", ")}): nothing was changed`
      );
    }
  }
  return there;
}

/** Counts what was copied aside (`at`): his data's lines and commit as exported, each store's rows exactly (a kept archive was checked by `refusal`). */
async function recount(m: Manifest, at: Install, kept: boolean) {
  const lines = linesIn(at.data);
  const lost = Object.entries(m.counts.lines).filter(
    ([p, n]) => lines[p] !== n
  );
  if (lost.length > 0 || (await headOf(at.data)) !== m.counts.head) {
    throw new Error(
      `his data is not as exported (${lost.map(([p]) => p).join(", ") || "its commit"}): nothing was changed`
    );
  }
  for (const [p, want] of Object.entries(m.counts.rows)) {
    const { part, path } = partOf(p);
    const off =
      kept && part === "archive"
        ? []
        : short(rowsIn(join(at[part as Part], path)), want, true);
    if (off.length > 0) {
      throw new Error(
        `${p} is not as exported (${off.join(", ")}): nothing was changed`
      );
    }
  }
}

/**
 * Puts the export in `dir` into this install, all or nothing (see above). Returns what the manifest left out
 * (secrets), for the owner to give by hand.
 */
export async function restore(dir: string, to: Install = HERE) {
  const m = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8")
  ) as Manifest;
  const kept = await refusal(m, to);
  const side: Install = {
    archive: `${to.archive}.importing`,
    data: `${to.data}.importing`,
    state: `${to.state}.importing`,
  };
  const at: Install = { ...side, archive: kept ? to.archive : side.archive };
  for (const p of PARTS) {
    rmSync(side[p], { force: true, recursive: true });
  }
  try {
    for (const f of m.files) {
      const { part, path } = partOf(f.path);
      // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed
      if ((await sha256Of(join(dir, f.path))) !== f.sha256) {
        throw new Error(`${f.path} is not as exported: nothing was changed`);
      }
      if (part !== "notes" && !(kept && part === "archive")) {
        mkdirSync(dirname(join(side[part], path)), { recursive: true });
        cpSync(join(dir, f.path), join(side[part], path));
      }
    }
    await recount(m, at, kept);
    await putNotes(
      await notesPlacesOf(
        dir,
        m,
        join(side.state, pathIn(LIFE_STATE_DIR, DESK_STORE)),
        to.state
      )
    );
    // In place: Life's state file by file (its folder may hold this install's own key), the archive, his data last.
    for (const f of m.files.filter((x) => partOf(x.path).part === "state")) {
      const { path } = partOf(f.path);
      mkdirSync(dirname(join(to.state, path)), { recursive: true });
      renameSync(join(side.state, path), join(to.state, path));
    }
    for (const p of kept
      ? ["data" as const]
      : ["archive" as const, "data" as const]) {
      // Empty, checked above: a folder that isn't fails here, it is never removed.
      if (existsSync(to[p])) {
        rmdirSync(to[p]);
      }
      renameSync(side[p], to[p]);
    }
  } finally {
    for (const p of PARTS) {
      rmSync(side[p], { force: true, recursive: true });
    }
  }
  return {
    files: m.files.length,
    /** A kept archive is never written to: what the export held beyond it (its media too) stayed out. */
    kept: kept ? to.archive : null,
    leftOut: m.leftOut,
  };
}
