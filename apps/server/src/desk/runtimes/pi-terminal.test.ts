import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiTerminalLaunch } from "./pi-terminal";

// His window closed (SIGHUP) ends the launcher's program and leaves no record behind: a record outliving its process
// would read as open. Made-up launch: `sleep` stands in for pi.

test("the launcher deletes its launch file, records the session while it runs, and leaves no record once his window closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-pi-terminal-"));
  const file = join(dir, "launch.json");
  const records = join(dir, "open");
  const launch: PiTerminalLaunch = {
    command: ["sleep", "60"],
    drop: [],
    entrypoint: "life-terminal",
    env: {},
    file: join(dir, "session.jsonl"),
    folder: dir,
    records,
    ref: "11111111-0000-4000-8000-000000000001",
  };
  writeFileSync(file, JSON.stringify(launch));
  const launcher = Bun.spawn(
    [process.execPath, join(import.meta.dir, "pi-terminal.ts"), file],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  const record = join(records, `${launcher.pid}.json`);
  for (let i = 0; i < 100 && !existsSync(record); i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: waits for the launcher's record
    await Bun.sleep(50);
  }
  expect(existsSync(record)).toBe(true);
  expect(existsSync(file)).toBe(false);
  launcher.kill("SIGHUP");
  await launcher.exited;
  expect(existsSync(record)).toBe(false);
});
