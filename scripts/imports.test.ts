import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIFE_CODE_DIR } from "@life/server/src/core/paths";
import { repoFiles } from "@life/server/src/core/proc";

// The rules on what the server's code imports, from one read of it.

const FROM = /\bfrom\s+"(\.{1,2}\/[^"]+)"/g;
const NAMED = /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g;
const SPACE = /\s+/;
const REMCTL = /"bin",\s*"remctl"/;
const GOG_TASKS = /"gog",\s*"tasks"/;

const files = repoFiles(LIFE_CODE_DIR, ["apps/server/src"], [".ts"]).filter(
  (f) => !f.endsWith(".test.ts")
);
const texts = new Map(
  files.map((f) => [f, readFileSync(join(LIFE_CODE_DIR, f), "utf8")])
);

// No module imports one that imports it back, type-only imports included (fallow's cycle check skips those): a
// capability's implementations import its contract.ts, and only its registry imports them (AGENTS.md).
test("no import cycles in the server's code", () => {
  const known = new Set(files);
  const edges = new Map<string, string[]>();
  for (const [f, text] of texts) {
    edges.set(
      f,
      [...text.matchAll(FROM)].flatMap(([, spec = ""]) => {
        const base = join(dirname(f), spec);
        return [`${base}.ts`, join(base, "index.ts")].filter((c) =>
          known.has(c)
        );
      })
    );
  }
  const cycles: string[] = [];
  const done = new Set<string>();
  const visit = (f: string, path: string[]) => {
    if (path.includes(f)) {
      cycles.push([...path.slice(path.indexOf(f)), f].join(" → "));
      return;
    }
    if (done.has(f)) {
      return;
    }
    for (const to of edges.get(f) ?? []) {
      visit(to, [...path, f]);
    }
    done.add(f);
  };
  for (const f of files) {
    visit(f, []);
  }
  expect(cycles).toEqual([]);
});

/** The files that import any of `names` (aliased too) from a path ending in `module`. */
const importers = (names: string[], module: string) =>
  files.filter((f) =>
    [...(texts.get(f) ?? "").matchAll(NAMED)].some(
      ([, what = "", path = ""]) =>
        path.endsWith(`/${module}`) &&
        what
          .split(",")
          .some((w) => names.includes(w.trim().split(SPACE)[0] ?? ""))
    )
  );
const running = (program: RegExp) =>
  files.filter((f) => program.test(texts.get(f) ?? ""));

// 2 Nov 2026: the agent boards wrote his Reminders beside `act`, so the minute pass read each of their items back as
// his new to-do and the board added it again: 147 copies in 85 minutes. One writer: only `act` reaches a backend.
test("only act writes his to-do list: it alone imports the backend, only the backend imports its implementations, and only they run remctl or gog tasks", () => {
  expect(importers(["backend", "write"], "backend")).toEqual([
    "apps/server/src/host/act.ts",
  ]);
  expect([
    ...importers(["reminders"], "remctl"),
    ...importers(["google"], "google"),
  ]).toEqual([
    "apps/server/src/todo-list/backend.ts",
    "apps/server/src/todo-list/backend.ts",
  ]);
  expect(running(REMCTL)).toEqual(["apps/server/src/todo-list/remctl.ts"]);
  expect(running(GOG_TASKS)).toEqual(["apps/server/src/todo-list/google.ts"]);
});
