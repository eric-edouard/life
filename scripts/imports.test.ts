import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SourceName } from "@life/server/src/core/names";
import { LIFE_CODE_DIR } from "@life/server/src/core/paths";
import { repoFiles } from "@life/server/src/core/proc";

// The rules on what the server's code imports and how it reads now and importance, from one read of it.

const FROM = /\bfrom\s+"(\.{1,2}\/[^"]+)"/g;
const NAMED = /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g;
const SPACE = /\s+/;
const REMCTL = /"bin",\s*"remctl"/;
const GOG = /"gog"/;
const GH = /"gh"/;
const GOG_TASKS = /gogCall\(\s*"tasks"/;
const GOG_GMAIL = /gogCall\(\s*"gmail"/;
const MONEY = /\["money",/;
const MESSAGES_APP = /tell application "Messages"/;
const MATRIX_SEND = /\/send\/|\/media\/v3\/upload/;
const BARE_IMPORTANCE = /importance\s*(?:[<>=!]=?=?)\s*\d|importance,\s*\d\)/;
const DIRECT_CLOCK = /Date\.now\(\)|new Date\(\)/;
const UTC_DAY = /toISOString\(\)\.slice\(0, ?10\)/;
const LINE_BREAK = /\r?\n/;
const DESK_IMPORT = /from "[^"]*\/desk\//;
const MODEL_SPAWN =
  /"claude",\s*"-p"|"codex",\s*"exec"|CODEX_BIN,\s*"exec"|\[\s*process\.execPath|\/chat\/completions|process\.env\.LIFE_FOUNDATION_MODEL/;
// A call's reads written by hand: a literal keyed by a source or `memory`.
const READS_LITERAL = new RegExp(
  `\\breads:\\s*\\{\\s*"?(${[...SourceName.options, "memory"].join("|")})"?\\s*:`
);
// Every file that calls a model (a spawn or a router's endpoint), in one list: the desk's runtimes may change shape.
const MODEL_CALL_FILES = [
  "apps/server/src/desk/runtimes/pi-runtime.ts",
  "apps/server/src/desk/runtimes/runtime-rows.ts",
  "apps/server/src/models/describer.ts",
  "apps/server/src/models/foundation-model.ts",
  "apps/server/src/models/llm.ts",
  "apps/server/src/models/routers.ts",
];
// Files over Biome's 800 lines (off for them in biome.json), each at its line count: 8 Nov 2026 debt audit (search.ts reached 1592 lines).
const CAPS: Record<string, number> = {
  "apps/lifelog/apps/server/src/jobs.test.ts": 1104,
  "apps/lifelog/apps/server/src/people.test.ts": 988,
  "apps/lifelog/apps/server/src/people.ts": 1177,
  "apps/lifelog/packages/db/src/schema/index.ts": 1065,
  "apps/server/src/host/status/snapshot.ts": 1142,
  "apps/server/src/memory/units.test.ts": 1186,
};

const files = repoFiles(LIFE_CODE_DIR, ["apps/server/src"], [".ts"]).filter(
  (f) => !f.endsWith(".test.ts")
);
const texts = new Map(
  files.map((f) => [f, readFileSync(join(LIFE_CODE_DIR, f), "utf8")])
);
/** The server's code and the scripts': what the model-call rule scans. */
const withScripts = new Map([
  ...texts,
  ...repoFiles(LIFE_CODE_DIR, ["scripts"], [".ts"])
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => [f, readFileSync(join(LIFE_CODE_DIR, f), "utf8")] as const),
]);

// No module imports one that imports it back, type-only imports included (fallow's cycle check skips those): a
// capability's implementations import its contract.ts, and only its registry imports them (docs/helpers.md).
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
const importers = (names: string[], module: string, among = texts) =>
  [...among.keys()].filter((f) =>
    [...(among.get(f) ?? "").matchAll(NAMED)].some(
      ([, what = "", path = ""]) =>
        path.endsWith(`/${module}`) &&
        what
          .split(",")
          .some((w) => names.includes(w.trim().split(SPACE)[0] ?? ""))
    )
  );
const running = (program: RegExp, among = texts) =>
  [...among.keys()].filter((f) => program.test(among.get(f) ?? ""));

// 2 Nov 2026: the agent boards wrote his Reminders beside `changeTodoItem`, so the minute pass read each of their items back as
// his new to-do and the board added it again: 147 copies in 85 minutes. One writer: only `changeTodoItem` reaches a backend.
test("only changeTodoItem writes his to-do list: it alone imports the backend, only the backend imports its implementations, and only they run remctl or gog tasks", () => {
  expect(importers(["backend", "write"], "backend")).toEqual([
    "apps/server/src/host/change-todo-item.ts",
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
  // His mail is sent only by Gmail through gog, in one file.
  expect(running(GOG_GMAIL)).toEqual(["apps/server/src/sources/gmail.ts"]);
  // Nothing else spawns gog: its name as a literal is in `core/gog.ts` alone.
  expect(running(GOG)).toEqual(["apps/server/src/core/gog.ts"]);
  // GitHub is read and written through `gh` in one file.
  expect(running(GH)).toEqual(["apps/server/src/sources/github.ts"]);
});

// Life sends only a card's draft, on his answer to its outgoing option (.claude/rules/acts-and-sends.md): one path, from his answer to the bridge.
test("only his answer to a decision sends: answerDecision alone calls sendDraft, which sends through a source's send path, and only matrixSend, the one Matrix send, is built by the sources", () => {
  expect(importers(["sendDraft"], "draft-send")).toEqual([
    "apps/server/src/memory/decisions.ts",
  ]);
  expect(importers(["matrixSend"], "matrix")).toEqual([
    "apps/server/src/memory/sources.ts",
    "apps/server/src/sources/bridged.ts",
  ]);
  expect(running(MATRIX_SEND)).toEqual(["apps/server/src/sources/matrix.ts"]);
  // The one iMessage send: only messages-app.ts tells Messages to send.
  expect(running(MESSAGES_APP)).toEqual([
    "apps/server/src/sources/messages-app.ts",
  ]);
});

// Life reads his payments only through money's `tx` contract, behind `payments()`.
test("only the payments backend imports money, and only money.ts runs the money CLI", () => {
  expect(importers(["money"], "money")).toEqual([
    "apps/server/src/payments/backend.ts",
  ]);
  expect(running(MONEY)).toEqual(["apps/server/src/payments/money.ts"]);
});

// A voice guess stays a guess (docs/glossary.md, "voice guess"): what acts on his word is pinned to its writers, so a
// file that reads or makes guesses (`voice-naming.ts`, `naming-context.ts`, `voice-guesses.ts`) can never be one of them:
// only the connector forwards a correction to lifelog, and only his word (the command and the connector, through
// `recordHisCorrection`, which checks a next step's context), his answer to a check (`answer-check.ts`) and a start's
// goal (`change-registered-agent.ts`) record one.
test("forward and recordCorrection have only their known importers", () => {
  expect(importers(["forward"], "lifelog")).toEqual([
    "apps/server/src/host/http/mcp.ts",
  ]);
  expect(importers(["recordCorrection"], "memory-files")).toEqual([
    "apps/server/src/host/change-registered-agent.ts",
    "apps/server/src/host/correct-matter.ts",
    "apps/server/src/memory/answer-check.ts",
    "apps/server/src/memory/delete-from-memory.ts",
  ]);
  expect(importers(["recordHisCorrection"], "correct-matter")).toEqual([
    "apps/server/src/desk/desk-door.ts",
    "apps/server/src/host/command.ts",
    "apps/server/src/host/http/mcp.ts",
  ]);
});

const lifelogTexts = repoFiles(LIFE_CODE_DIR, ["apps/lifelog"], [".ts"])
  .filter((f) => !f.endsWith(".test.ts"))
  .map((f) => [f, readFileSync(join(LIFE_CODE_DIR, f), "utf8")] as const);
/** The `file:line`s of server code (and lifelog's, with `lifelog`) matching `pattern`, outside the files in `except`. */
const linesMatching = (
  pattern: RegExp,
  except: string[],
  lifelog = false,
  among = texts
) =>
  [...among, ...(lifelog ? lifelogTexts : [])].flatMap(([f, text]) =>
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

// docs/helpers.md: now is `clock()`, in lifelog too (78 direct reads until 8 Nov 2026).
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

// The desk is the top layer (.claude/rules/one-way.md): nothing of Life imports it, so the night, the watcher and the connector run the
// same with it stopped (the desk spec's W19). Fallow's zones cover the server; this covers the scripts too.
test("nothing outside the desk imports it", () => {
  expect(
    repoFiles(LIFE_CODE_DIR, ["apps/server/src", "scripts"], [".ts"]).filter(
      (f) =>
        !f.startsWith("apps/server/src/desk/") &&
        DESK_IMPORT.test(readFileSync(join(LIFE_CODE_DIR, f), "utf8"))
    )
  ).toEqual([]);
});

test("no two of the server's files share a name, a capability's contract.ts and backend.ts aside", () => {
  const names = files
    .map((f) => basename(f))
    .filter((n) => n !== "contract.ts" && n !== "backend.ts");
  expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
});

// 19 Nov 2026: a night's spend missed two of its steps, and no call said what it read. Each memory call goes through
// askOnce, which refuses one that names no reads; reads are made only by readsOf, so none is written by hand.
test("every model call is made in a known file, and every memory call goes through askOnce with reads made by readsOf", () => {
  expect(importers(["askOnce"], "llm", withScripts).toSorted()).toEqual([
    "apps/server/src/memory/run.ts",
    "apps/server/src/memory/tally.ts",
    "scripts/memory-pilot.ts",
    "scripts/question-cases.ts",
  ]);
  expect(importers(["askRoutes", "ROUTERS"], "routers", withScripts)).toEqual([
    "apps/server/src/models/llm.ts",
  ]);
  expect(importers(["startDescriber"], "describer", withScripts)).toEqual([
    "apps/server/src/host/describe-photos.ts",
  ]);
  expect(
    importers(["askFoundationModel"], "foundation-model", withScripts)
  ).toEqual(["apps/server/src/memory/arrival-reader.ts"]);
  expect(running(MODEL_SPAWN, withScripts).toSorted()).toEqual(
    MODEL_CALL_FILES
  );
  expect(
    linesMatching(
      READS_LITERAL,
      ["apps/server/src/memory/run.ts"],
      false,
      withScripts
    )
  ).toEqual([]);
});
