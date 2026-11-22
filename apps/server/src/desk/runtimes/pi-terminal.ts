import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Life's launcher of a pi session he continues on his Mac (`continue_on_mac`), run in Terminal by the helper as bun
// (`pi-runtime.ts`'s `continueOnMac`): reads and deletes its launch file (Life's part of the run's environment, a
// secret), runs pi's own interface on the session with Life's extension (the send guard) in his Terminal's environment,
// and keeps a record (`open-session-records.ts`) while pi runs, so the desk shows it open and holds its wakes. It imports
// nothing of Life's: the app bundles it alone (`scripts/helper.ts`).

/** What the desk hands the launcher (`pi-runtime.ts`). */
export interface PiTerminalLaunch {
  command: string[];
  /** His Terminal's variables pi must not see (the engine's key: Life's own is in `env`). */
  drop: string[];
  entrypoint: string;
  env: Record<string, string>;
  folder: string;
  records: string;
  ref: string;
}

if (import.meta.main) {
  const file = process.argv[2] ?? "";
  const launch: PiTerminalLaunch = JSON.parse(readFileSync(file, "utf8"));
  rmSync(file, { force: true });
  const env = { ...process.env, ...launch.env };
  for (const k of launch.drop) {
    delete env[k];
  }
  // pi reads its keys raw; a signal still reaching the launcher must not leave pi running unrecorded.
  process.on("SIGINT", () => undefined);
  const [program = "", ...args] = launch.command;
  const pi = spawn(program, args, {
    cwd: launch.folder,
    env,
    stdio: "inherit",
  });
  // Written once pi runs, so the desk's `pgrep` already sees it when the record says "open".
  mkdirSync(launch.records, { recursive: true });
  const record = join(launch.records, `${process.pid}.json`);
  writeFileSync(
    record,
    JSON.stringify({
      entrypoint: launch.entrypoint,
      pid: process.pid,
      sessionId: launch.ref,
      startedAt: Date.now(),
    })
  );
  pi.on("exit", (code) => {
    rmSync(record, { force: true });
    process.exit(code ?? 0);
  });
}
