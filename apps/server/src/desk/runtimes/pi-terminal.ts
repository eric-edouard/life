import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Life's launcher of a pi session he continues on his Mac (`continue_on_mac`), run in Terminal by the helper as bun
// (`pi-runtime.ts`'s `continueOnMac`): reads and deletes its launch file (Life's part of the run's environment, a
// secret), runs pi's own interface on the session with Life's extension (the send guard) in his Terminal's environment,
// and keeps a record (`open-session-records.ts`) while pi runs, so the desk shows it open and holds its wakes; its quiet
// is the session file's last write, so the desk takes it back (SIGTERM, passed to pi) once he left it. It imports
// nothing of Life's: the app bundles it alone (`scripts/helper.ts`).

/** What the desk hands the launcher (`pi-runtime.ts`). */
export interface PiTerminalLaunch {
  command: string[];
  /** His Terminal's variables pi must not see (the engine's key: Life's own is in `env`). */
  drop: string[];
  entrypoint: string;
  env: Record<string, string>;
  /** The session's file: its last write is his last word or the agent's. */
  file: string;
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
  // Written once pi runs, so the desk's `pgrep` already sees it when the record says "open"; again each 15 s with the
  // session's last write as its quiet.
  mkdirSync(launch.records, { recursive: true });
  const record = join(launch.records, `${process.pid}.json`);
  const startedAt = Date.now();
  const write = () => {
    let statusUpdatedAt = startedAt;
    try {
      statusUpdatedAt = Math.max(startedAt, statSync(launch.file).mtimeMs);
    } catch {
      // not written yet
    }
    writeFileSync(
      record,
      JSON.stringify({
        entrypoint: launch.entrypoint,
        pid: process.pid,
        sessionId: launch.ref,
        startedAt,
        status: "idle",
        statusUpdatedAt,
      })
    );
  };
  write();
  const timer = setInterval(write, 15_000);
  // The desk takes it back once he left it: pi ends, said in his window.
  process.on("SIGTERM", () => {
    process.stdout.write("\nLife took it back: it continues there.\n");
    pi.kill("SIGTERM");
  });
  pi.on("exit", (code) => {
    clearInterval(timer);
    rmSync(record, { force: true });
    process.exit(code ?? 0);
  });
}
