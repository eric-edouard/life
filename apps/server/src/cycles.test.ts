import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./core/paths";
import { repoFiles } from "./core/proc";

// No module imports one that imports it back, type-only imports included (fallow's cycle check skips those): a
// capability's implementations import its contract.ts, and only its registry imports them (AGENTS.md).

const FROM = /\bfrom\s+"(\.{1,2}\/[^"]+)"/g;

test("no import cycles in the server's code", () => {
  const files = repoFiles(ROOT, ["apps/server/src"], [".ts"]).filter(
    (f) => !f.endsWith(".test.ts")
  );
  const known = new Set(files);
  const edges = new Map<string, string[]>();
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), "utf8");
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
