import { parseArgs } from "node:util";
import { Asked, actAsked, requested, setGrant } from "./actions";
import { archiveCommand } from "./archive";
import { backup } from "./backup";
import { init } from "./init";
import { readEngine } from "./llm";
import { memoryCommand } from "./memory/command";
import { actionLine, duration } from "./memory/report";
import { dayRange } from "./memory/units";
import { pair } from "./oauth";
import { checks } from "./reminders/remctl";
import { Engine } from "./schema";
import { readSettings, type Settings, setSetting, settings } from "./settings";
import { SOURCES } from "./sources/index";
import { connect } from "./tailscale";
import { ask, timings } from "./tasks";
import { integrity, loadTruth } from "./truth";
import { status, watch } from "./watch";

const commands: Record<string, () => Promise<number>> = {
  /**
   * Acts on the owner's clear request, for a Claude session: `act '<json>'` (a change with `said`, his words, and
   * `why`); `act --check` (read-only: can remctl act now?). Every action is recorded in memory/actions.jsonl.
   */
  async act() {
    const [arg] = process.argv.slice(3);
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
  async engine() {
    const [, , , arg] = process.argv;
    if (arg === undefined) {
      console.log(readEngine());
      return 0;
    }
    const engine = Engine.safeParse(arg);
    if (!engine.success) {
      console.error(`usage: bun life engine [${Engine.options.join("|")}]`);
      return 2;
    }
    await setSetting("engine", engine.data);
    console.log(`engine: ${engine.data}`);
    return 0;
  },
  /**
   * The standing grant (decision 2), only on his own words in this conversation: `grant on|off '<his words>'`. Off
   * until he says yes; his undo of one of its reminders turns it off again.
   */
  async grant() {
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
  async settings() {
    const [verb, arg] = process.argv.slice(3);
    if (verb === "set") {
      const parts = JSON.parse(arg ?? "{}") as Partial<Settings>;
      for (const [key, value] of Object.entries(parts)) {
        // biome-ignore lint/performance/noAwaitInLoops: one small file, in order
        await setSetting(key as keyof Settings, value as never);
      }
    }
    console.log(JSON.stringify(readSettings(), null, 2));
    return 0;
  },
  /** Every source as JSON: its name and label, whether he turned it on, and what keeps it from being read now. */
  sources() {
    const on = new Set<string>(settings().sources);
    console.log(
      JSON.stringify(
        SOURCES.map((s) => ({
          label: s.label,
          missing: s.missing?.() ?? null,
          name: s.name,
          on: on.has(s.name),
        }))
      )
    );
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
