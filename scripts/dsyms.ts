// The dSYM store: every build installed on the phone or the Watch keeps its dSYMs here, outside any
// worktree, as <STORE>/<binary UUID>/<name>.dSYM beside a build.json (commit, date, UUIDs).
// install-phone.ts fills it; symbolicate.ts reads it.
import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { clock } from "@life/server/src/core/clock";
import { $, Glob } from "bun";

const STORE = `${homedir()}/Library/Application Support/lifelog/dsyms`;
const UUID_LINE = /^UUID: ([0-9A-F-]{36}) \((\w+)\) (.+)$/gm;

interface Dwarf {
  arch: string;
  bundle: string;
  file: string;
}

// Binary UUID to its DWARF file, for every dSYM bundle `pattern` matches under `dir`.
async function dwarfsIn(dir: string, pattern: string) {
  const bundles = existsSync(dir)
    ? [
        ...new Glob(pattern).scanSync({
          absolute: true,
          cwd: dir,
          onlyFiles: false,
        }),
      ]
    : [];
  const out =
    bundles.length > 0
      ? await $`dwarfdump --uuid ${bundles}`.quiet().nothrow().text()
      : "";
  return new Map<string, Dwarf>(
    [...out.matchAll(UUID_LINE)].map(([, uuid = "", arch = "", file = ""]) => [
      uuid,
      { arch, bundle: file.slice(0, file.indexOf(".dSYM/") + 5), file },
    ])
  );
}

// Copies every dSYM under `dir` (pattern relative to it) into the store, and says what it kept.
export async function archive(dir: string, pattern: string, commit: string) {
  const found = await dwarfsIn(dir, pattern);
  if (found.size === 0) {
    throw new Error(`no dSYMs under ${dir}`);
  }
  const build = {
    archivedAt: clock().toISOString(),
    binaries: Object.fromEntries(
      [...found].map(([uuid, d]) => [uuid, basename(d.bundle)])
    ),
    commit,
  };
  await Promise.all(
    [...found].map(async ([uuid, { bundle }]) => {
      const into = `${STORE}/${uuid}`;
      await mkdir(into, { recursive: true });
      await cp(bundle, `${into}/${basename(bundle)}`, { recursive: true });
      await Bun.write(
        `${into}/build.json`,
        `${JSON.stringify(build, null, 2)}\n`
      );
    })
  );
  return build;
}

// The DWARF file of each UUID the store has.
export async function findDwarfs(uuids: Iterable<string>) {
  const sources = await Promise.all(
    [...uuids].map((uuid) => dwarfsIn(`${STORE}/${uuid}`, "*.dSYM"))
  );
  return new Map(sources.flatMap((source) => [...source]));
}

// The root checkout (the worktrees' common parent) and this one.
export async function checkouts() {
  const common = await $`git rev-parse --path-format=absolute --git-common-dir`
    .quiet()
    .text();
  const top = await $`git rev-parse --show-toplevel`.quiet().text();
  return [...new Set([dirname(common.trim()), top.trim()])];
}
