import { Asked, actAsked, checks, requested } from "./actions";
import { archiveCommand } from "./archive";
import { backup } from "./backup";
import { readEngine, setEngine } from "./llm";
import { memoryCommand } from "./memory/command";
import { actionLine } from "./memory/report";
import { Engine } from "./schema";
import { ask } from "./tasks";
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
  /** The daily restic snapshot to iCloud Drive, and weekly its forget, prune and check (src/backup.ts). */
  backup,
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
    await setEngine(engine.data);
    console.log(`engine: ${engine.data}`);
    return 0;
  },
  /** The memory pipeline and its read path: `memory nightly|moments|extract|search…` (src/memory/command.ts). */
  memory: () => memoryCommand(process.argv.slice(3)),
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
