import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./platform";
import { exec, execOk } from "./proc";

// A program the Mac keeps running on its own, outside Life.app: one launchd job each (the bridges and their homeserver,
// `host/bridges.ts`), started at login, started again 10 s after it stops, its output in ~/Library/Logs/<label>.log.
// macOS only.

const AGENTS = join(HOME, "Library", "LaunchAgents");
const labelOf = (job: string) => `com.ericedouard.life.${job}`;
const domain = () => `gui/${process.getuid?.()}`;
const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Keeps `args` running in `dir` as job `job`, replacing the job of that name if there is one. */
export async function keepRunning(job: string, dir: string, args: string[]) {
  const label = labelOf(job);
  const log = join(HOME, "Library", "Logs", `${label}.log`);
  const plist = join(AGENTS, `${label}.plist`);
  mkdirSync(AGENTS, { recursive: true });
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(dir)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`
  );
  await exec(["launchctl", "bootout", `${domain()}/${label}`]);
  await execOk(["launchctl", "bootstrap", domain(), plist]);
}

/** Stops job `job` and forgets it. */
export async function stopRunning(job: string) {
  const label = labelOf(job);
  await exec(["launchctl", "bootout", `${domain()}/${label}`]);
  rmSync(join(AGENTS, `${label}.plist`), { force: true });
}

/** Starts job `job` again now. */
export const restartRunning = (job: string) =>
  exec(["launchctl", "kickstart", "-k", `${domain()}/${labelOf(job)}`]);

export const isRunning = async (job: string) =>
  (await exec(["launchctl", "print", `${domain()}/${labelOf(job)}`])).code ===
  0;
