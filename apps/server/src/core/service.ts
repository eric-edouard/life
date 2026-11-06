import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./platform";
import { exec, execOk, untilAnswers } from "./proc";

// A program the Mac keeps running on its own, outside Life.app, as one launchd job (the bridges and their homeserver
// together, `host/bridges.ts`): started at login, started again 10 s after it stops, its output in
// ~/Library/Logs/<label>.log. macOS only.

const AGENTS = join(HOME, "Library", "LaunchAgents");
const labelOf = (job: string) => `com.ericedouard.life.${job}`;
const domain = () => `gui/${process.getuid?.()}`;
const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Keeps `args` running in `dir` as job `job`, replacing (so restarting) the job of that name if there is one. */
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
  const target = `${domain()}/${label}`;
  await exec(["launchctl", "bootout", target]);
  // bootout returns before the job is gone, and a bootstrap then fails (6 Nov 2026: every bridge down): wait for it.
  await untilAnswers(
    async () =>
      (await exec(["launchctl", "print", target])).code !== 0 || undefined,
    `${label} stopping`
  );
  await execOk(["launchctl", "bootstrap", domain(), plist]);
}
