import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { STORES } from "./archive";
import {
  FORMAT,
  headOf,
  linesIn,
  type Manifest,
  rowsIn,
  sha256Of,
} from "./export";
import { isEmpty } from "./init";
import { SETTINGS } from "./settings";
import { ARCHIVE, archiveDb } from "./sources/archived";
import { storeFiles } from "./sources/lifelog";
import { DATA, STATE } from "./truth";

// A Life export (`stage`, export.ts) put back: a new install's data, state and archive. All or nothing: refused at
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
const HERE: Install = { archive: ARCHIVE, data: DATA, state: STATE };
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
/** A manifest path's part (`data/x` is data's `x`), and the path inside it; one that leaves its part is refused. */
const partOf = (p: string) => {
  const [part, ...rest] = p.split("/");
  if (!PARTS.includes(part as Part) || rest.includes("..")) {
    throw new Error(`${p} is no path of an export: nothing was changed`);
  }
  return { part: part as Part, path: rest.join("/") };
};

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
  const marks = [SETTINGS, ...Object.values(storeFiles())].map((p) =>
    relative(STATE, p)
  );
  for (const p of marks) {
    const at = join(to.state, p);
    // biome-ignore lint/performance/noAwaitInLoops: three files at most
    if (existsSync(at) && (await sha256Of(at)) !== listed.get(`state/${p}`)) {
      throw new Error(
        `${to.state} holds an install already: nothing was changed`
      );
    }
  }
  const there = STORES.some((s) => existsSync(archiveDb(s.name, to.archive)));
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
        : short(rowsIn(join(at[part], path)), want, true);
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
      if (!(kept && part === "archive")) {
        mkdirSync(dirname(join(side[part], path)), { recursive: true });
        cpSync(join(dir, f.path), join(side[part], path));
      }
    }
    await recount(m, at, kept);
    // In place: Life's state file by file (its folder may hold this install's own key), the archive, his data last.
    for (const f of m.files.filter((x) => partOf(x.path).part === "state")) {
      const { path } = partOf(f.path);
      mkdirSync(dirname(join(to.state, path)), { recursive: true });
      renameSync(join(side.state, path), join(to.state, path));
    }
    for (const p of kept
      ? ["data" as const]
      : ["archive" as const, "data" as const]) {
      rmSync(to[p], { force: true, recursive: true }); // empty, checked above
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
