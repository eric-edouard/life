import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Asked, actAsked, requested, setGrant } from "./actions";
import { archiveCommand } from "./archive";
import { backup } from "./backup";
import { stage } from "./export";
import { LOCAL_PORT } from "./http";
import { restore } from "./import";
import { init, started } from "./init";
import { readEngine } from "./llm";
import { memoryCommand, step } from "./memory/command";
import { dryRun, importExport } from "./memory/imports";
import { actionLine, duration, REPORTS } from "./memory/report";
import { dayRange } from "./memory/units";
import { pair } from "./oauth";
import {
  checks,
  REMCTL_RELEASE,
  remctlVersion,
  remindersOn,
} from "./reminders/remctl";
import { Engine } from "./schema";
import { readSettings, type Settings, setSettings, settings } from "./settings";
import { localKey } from "./signin";
import { FULL_DISK, SOURCES } from "./sources/index";
import { connect } from "./tailscale";
import { ask, timings } from "./tasks";
import { integrity, loadTruth } from "./truth";
import { status, watch } from "./watch";

/** `act` and the grant need the Reminders plugin: off, they say so and do nothing. */
const pluginOff = () => {
  if (!remindersOn()) {
    console.error("Reminders is off (settings: reminders)");
  }
  return !remindersOn();
};

const commands: Record<string, () => Promise<number>> = {
  /**
   * Acts on the owner's clear request, for a Claude session: `act '<json>'` (a change with `said`, his words, and
   * `why`); `act --check` (read-only: can remctl act now?). Every action is recorded in memory/actions.jsonl.
   */
  async act() {
    const [arg] = process.argv.slice(3);
    if (pluginOff()) {
      return 2;
    }
    if (arg === "--check") {
      const problems = await checks();
      console.log(problems.join("\n") || "remctl ready");
      return problems.length > 0 ? 1 : 0;
    }
    let asked: Asked;
    try {
      asked = Asked.parse(JSON.parse(arg ?? ""));
    } catch (e) {
      console.error(
        `usage: bun life act '<json>' | --check\n${(e as Error).message}`
      );
      return 2;
    }
    const done = await actAsked(asked, "session");
    console.log(`${done.id} ${done.result}: ${actionLine(done)}`);
    return done.result === "failed" ? 1 : 0;
  },
  /**
   * What the app shows, as JSON, so it reads none of Life's files: whether Life is set up, the newest report kept on
   * the Mac, every source with whether he turned it on, what keeps it from being read now and whether that is Full
   * Disk Access, the Reminders plugin (on or not, the remctl installed and the release Life installs), and the status
   * page the watcher serves on this Mac with the key that opens it (`localKey`).
   */
  async app() {
    const on = new Set<string>(settings().sources);
    const reports = existsSync(REPORTS)
      ? readdirSync(REPORTS)
          .map((f) => join(REPORTS, f))
          .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      : [];
    console.log(
      JSON.stringify({
        lastReport: reports[0] ?? null,
        reminders: await (async () => {
          const installed = await remctlVersion();
          return {
            installed,
            on: remindersOn(),
            /** remctl as Life wants it: installed, at the pinned release. */
            ready: installed === REMCTL_RELEASE.version,
            release: REMCTL_RELEASE,
          };
        })(),
        sources: SOURCES.map((s) => {
          const missing = s.missing?.() ?? null;
          return {
            fullDisk: missing === FULL_DISK,
            label: s.label,
            missing,
            name: s.name,
            on: on.has(s.name),
          };
        }),
        started: started(),
        status: { key: localKey(), url: `http://127.0.0.1:${LOCAL_PORT}/` },
      })
    );
    return 0;
  },
  /** Keeps every WhatsApp message before a delete wipes it: `archive [--once]`, `archive deleted [days]`. */
  archive: () => archiveCommand(process.argv.slice(3)),
  /** Hands work to Atlas from a Claude session: `ask '<his words>'` records an ask, which the watcher delivers. */
  ask() {
    const words = process.argv.slice(3).join(" ").trim();
    if (words.length < 3) {
      console.error("usage: bun life ask '<words>'");
      return Promise.resolve(2);
    }
    const done = ask(
      requested("session", words),
      { confidence: "high" },
      "session",
      "asked in a Claude session"
    );
    console.log(`${done.id}: ${actionLine(done)}`);
    return Promise.resolve(0);
  },
  /**
   * Where each ask's time went: `asks [--from d] [--to d]` (local days, `--to` inclusive), one line per ask, in the order recorded, each moment as
   * the time since the one before it (src/tasks.ts `timings`).
   */
  async asks() {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: { from: { type: "string" }, to: { type: "string" } },
    });
    const { from, to } = dayRange(values.from, values.to);
    for (const { id, madeBy, moments, quote } of await timings(from, to)) {
      const [[, spoke] = [], ...rest] = moments;
      let prev = spoke ?? "";
      const hops = rest.flatMap(([moment, at]) => {
        const hop = at
          ? [`${moment} +${duration(Date.parse(at) - Date.parse(prev))}`]
          : [];
        prev = at ?? prev;
        return hop;
      });
      const words = JSON.stringify(quote.slice(0, 60));
      console.log(
        [
          spoke?.replace("T", " ").slice(0, 19),
          id,
          madeBy,
          ...hops,
          words,
        ].join("  ")
      );
    }
    return 0;
  },
  /** The daily restic snapshot to iCloud Drive, and weekly its forget, prune and check (src/backup.ts). */
  backup,
  /** Puts Life on this Mac's tailnet name: `connect` for his own devices, `connect --public` for ChatGPT and Claude.ai too. */
  async connect() {
    const origin = await connect(process.argv.includes("--public"));
    console.log(`Life: ${origin}/mcp`);
    return 0;
  },
  /** Which engine runs the model steps: `engine [claude|codex]`; with no argument, prints the current one. */
  engine() {
    const [, , , arg] = process.argv;
    if (arg === undefined) {
      console.log(readEngine());
      return Promise.resolve(0);
    }
    const engine = Engine.safeParse(arg);
    if (!engine.success) {
      console.error(`usage: bun life engine [${Engine.options.join("|")}]`);
      return Promise.resolve(2);
    }
    setSettings({ engine: engine.data });
    console.log(`engine: ${engine.data}`);
    return Promise.resolve(0);
  },
  /** Everything Life holds, into a new folder with its manifest (src/export.ts): `export <dir>`. No secrets. */
  async export() {
    const [dir] = process.argv.slice(3);
    if (!dir) {
      console.error("usage: bun life export <dir>");
      return 2;
    }
    const m = await stage(dir);
    const bytes = m.files.reduce((n, f) => n + f.size, 0);
    console.log(
      `${dir}: ${m.files.length} files, ${(bytes / 1e9).toFixed(1)} GB. Not in it, give them by hand: ${[...m.leftOut.env, "Life's Keychain items"].join(", ")}`
    );
    return 0;
  },
  /**
   * The standing grant (decision 2), only on his own words in this conversation: `grant on|off '<his words>'`. Off
   * until he says yes; his undo of one of its reminders turns it off again.
   */
  async grant() {
    if (pluginOff()) {
      return 2;
    }
    const [state, ...words] = process.argv.slice(3);
    const said = words.join(" ").trim();
    if (!(state === "on" || state === "off") || said.length < 3) {
      console.error("usage: bun life grant on|off '<his words>'");
      return 2;
    }
    const done = await setGrant(state === "on", said);
    console.log(`${done.id}: ${actionLine(done)}`);
    return 0;
  },
  /**
   * One verb for whatever is brought in (`import <folder> [--dry]`): a Life export (a manifest: `restore`, into a new
   * install, checked before and counted after), or his claude.ai or ChatGPT export (once; `--dry` only counts).
   */
  async import() {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args: process.argv.slice(3),
      options: { dry: { type: "boolean" } },
    });
    const [dir] = positionals;
    if (!dir) {
      console.error("usage: bun life import <folder> [--dry]");
      return 2;
    }
    if (existsSync(join(dir, "manifest.json"))) {
      if (values.dry) {
        console.error(
          "--dry counts an assistant export; a Life export is checked as it is imported"
        );
        return 2;
      }
      const r = await restore(dir);
      console.log(
        `Life: ${r.files} files imported, checked and counted. Give by hand: ${Object.values(r.leftOut).flat().join("; ")}`
      );
      return 0;
    }
    if (values.dry) {
      console.log(JSON.stringify(dryRun(dir)));
      return 0;
    }
    // Its copy goes into his data: a new install starts first (`init`), or brings a Life export.
    if (!started()) {
      console.error(
        "Start Life first (or import a Life export): an assistant export goes into a set-up Life"
      );
      return 2;
    }
    return step(() => importExport(dir))({}, []);
  },
  /** A new install's data, once: `init --name <his name> [--email a]… [--phone +33…]…`. */
  async init() {
    const { values: v } = parseArgs({
      args: process.argv.slice(3),
      options: {
        email: { multiple: true, type: "string" },
        name: { type: "string" },
        phone: { multiple: true, type: "string" },
      },
    });
    if (!v.name) {
      console.error(
        "usage: bun life init --name <name> [--email a]… [--phone +33…]…"
      );
      return 2;
    }
    await init({ email: v.email ?? [], name: v.name, phone: v.phone ?? [] });
    console.log("Life: data ready");
    return 0;
  },
  /** The memory pipeline and its read path: `memory nightly|moments|extract|search…` (src/memory/command.ts). */
  memory: () => memoryCommand(process.argv.slice(3)),
  /** A code to approve an app's connection to Life's own sign-in (`oauth.ts`), good for 5 minutes. */
  pair() {
    console.log(pair());
    return Promise.resolve(0);
  },
  /**
   * The settings as JSON (`settings`), or some parts of them replaced (`settings set '<json>'`, checked whole before
   * anything is written): the app reads and writes them only through this, so their shape lives in one place.
   */
  settings() {
    const [verb, arg] = process.argv.slice(3);
    if (verb === "set") {
      setSettings(JSON.parse(arg ?? "{}") as Partial<Settings>);
    }
    console.log(JSON.stringify(readSettings(), null, 2));
    return Promise.resolve(0);
  },
  /** What the lifelog watcher says about itself (derived/watch/health.json). */
  status: () => Promise.resolve(status()),
  /** Validates truth/: schemas plus every reference between people, chats, projects and areas. */
  async validate() {
    const issues = integrity(await loadTruth());
    for (const issue of issues) {
      console.error(`✗ ${issue}`);
    }
    if (issues.length === 0) {
      console.log("✓ truth is consistent");
    }
    return issues.length === 0 ? 0 : 1;
  },
  /** Follows lifelog's change feed and keeps the lifelog units current; never returns (the LaunchAgent). */
  watch,
};

const name = process.argv[2] ?? "";
const command = commands[name];
if (!command) {
  console.error(`usage: bun life <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
process.exit(await command());
