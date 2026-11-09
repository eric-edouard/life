import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LIFE_CODE_DIR } from "@life/server/src/core/paths";
import { repoFiles } from "@life/server/src/core/proc";

// The rules on what the server's code imports and how it reads now and importance, from one read of it.

const FROM = /\bfrom\s+"(\.{1,2}\/[^"]+)"/g;
const NAMED = /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g;
const SPACE = /\s+/;
const REMCTL = /"bin",\s*"remctl"/;
const GOG_TASKS = /"gog",\s*"tasks"/;
const MONEY = /\["money",/;
const BARE_IMPORTANCE = /importance\s*(?:[<>=!]=?=?)\s*\d|importance,\s*\d\)/;
const DIRECT_CLOCK = /Date\.now\(\)|new Date\(\)/;
const UTC_DAY = /toISOString\(\)\.slice\(0, ?10\)/;
const LINE_BREAK = /\r?\n/;
// Files over Biome's 800 lines (off for them in biome.json), each at its line count: 8 Nov 2026 debt audit (search.ts reached 1592 lines).
const CAPS: Record<string, number> = {
  "apps/lifelog/apps/server/src/grouping.test.ts": 814,
  "apps/lifelog/apps/server/src/grouping.ts": 957,
  "apps/lifelog/apps/server/src/intelligence.test.ts": 1055,
  "apps/lifelog/apps/server/src/jobs.test.ts": 1486,
  "apps/lifelog/apps/server/src/jobs.ts": 930,
  "apps/lifelog/apps/server/src/mac-llm.test.ts": 831,
  "apps/lifelog/apps/server/src/naming-queue.test.ts": 834,
  "apps/lifelog/apps/server/src/people.test.ts": 991,
  "apps/lifelog/apps/server/src/people.ts": 1224,
  "apps/lifelog/packages/db/src/schema/index.ts": 1091,
  "apps/server/src/host/status/snapshot.ts": 1220,
  "apps/server/src/memory/observe.test.ts": 848,
  "apps/server/src/memory/units.test.ts": 1299,
  "apps/server/src/sources/lifelog.ts": 938,
};

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

// Life reads his payments only through money's `tx` contract, behind `payments()`.
test("only the payments backend imports money, and only money.ts runs the money CLI", () => {
  expect(importers(["money"], "money")).toEqual([
    "apps/server/src/payments/backend.ts",
  ]);
  expect(running(MONEY)).toEqual(["apps/server/src/payments/money.ts"]);
});

const lifelogTexts = repoFiles(LIFE_CODE_DIR, ["apps/lifelog"], [".ts"])
  .filter((f) => !f.endsWith(".test.ts"))
  .map((f) => [f, readFileSync(join(LIFE_CODE_DIR, f), "utf8")] as const);
/** The `file:line`s of server code (and lifelog's, with `lifelog`) matching `pattern`, outside the files in `except`. */
const linesMatching = (pattern: RegExp, except: string[], lifelog = false) =>
  [...texts, ...(lifelog ? lifelogTexts : [])].flatMap(([f, text]) =>
    except.includes(f)
      ? []
      : text
          .split("\n")
          .flatMap((l, i) => (pattern.test(l) ? [`${f}:${i + 1}`] : []))
  );

// 8 Nov 2026: three bare 3s decided "what must not be missed" apart. A threshold is named once, in records/unit.ts.
test("no importance is compared with or capped at a bare number: KEEP_AT, SEARCHABLE_AT, TOP_AT", () => {
  expect(linesMatching(BARE_IMPORTANCE, [])).toEqual([]);
});

// AGENTS.md, "One way": now is `clock()`, in lifelog too (78 direct reads until 8 Nov 2026).
test("now is read only through clock()", () => {
  expect(
    linesMatching(DIRECT_CLOCK, ["apps/server/src/core/clock.ts"], true)
  ).toEqual([]);
});

// A calendar day is `localDate`, `dayNow` or `daysBefore`; a tripwire (`iso(…).slice` slips by).
test("no calendar day is cut from a UTC instant", () => {
  expect(
    linesMatching(UTC_DAY, [
      "apps/server/src/core/clock.ts",
      // A birthday's date, not a day of his.
      "apps/server/src/memory/details.ts",
    ])
  ).toEqual([]);
});

test("a file over 800 lines never grows: its cap in CAPS is its length, lowered as it shrinks", () => {
  // Its exact length (all lines), so a cap is never left above the file; under 800, it leaves CAPS and the biome.json override.
  const over = Object.keys(CAPS).map((path) => {
    const lines = readFileSync(join(LIFE_CODE_DIR, path), "utf8")
      .trimEnd()
      .split(LINE_BREAK).length;
    return [path, lines, lines > 800];
  });
  expect(over).toEqual(
    Object.entries(CAPS).map(([path, cap]) => [path, cap, true])
  );
  const biome = JSON.parse(
    readFileSync(join(LIFE_CODE_DIR, "biome.json"), "utf8")
  ) as { overrides: { includes: string[]; linter?: unknown }[] };
  const off = biome.overrides.find((o) =>
    JSON.stringify(o.linter).includes('"noExcessiveLinesPerFile":"off"')
  );
  expect(off?.includes).toEqual(Object.keys(CAPS).toSorted());
});

test("no two of the server's files share a name, a capability's contract.ts and backend.ts aside", () => {
  const names = files
    .map((f) => basename(f))
    .filter((n) => n !== "contract.ts" && n !== "backend.ts");
  expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
});
