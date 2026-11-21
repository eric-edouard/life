import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "./log";
import { errorOf } from "./log-line";
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
  const output = join(HOME, "Library", "Logs", `${label}.log`);
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
<key>StandardOutPath</key><string>${xml(output)}</string><key>StandardErrorPath</key><string>${xml(output)}</string>
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

const LOG_END = /\.log$/;
/** The process logs past this size are rotated (`rotateProcessLogs`). */
const LOG_CAP = 10_000_000;
/** Life's process logs: Life.app's helpers, Lifelog Host's children and the launchd jobs; never a `.old.log`. */
const PROCESS_LOG =
  /^(?:life-|lifelog-|com\.ericedouard\.life\.).*(?<!\.old)\.log$/;

/**
 * The one rotation rule for every process log in ~/Library/Logs: past `LOG_CAP`, copied to `<name>.old.log` (the one
 * kept) and emptied in place, so its writers (who append: launchd, `O_APPEND` in both apps' supervisors) go on
 * writing into it. Regular files only (never through a link), each on its own: one that fails is logged and the rest
 * still rotate. Run by his own Life's watcher alone (a demo's would fight over his logs). Returns the names rotated.
 * ponytail: a line written between the copy and the truncate is lost (logrotate's copytruncate); a child's output
 * can't be reopened without restarting it.
 */
export function rotateProcessLogs(dir = join(HOME, "Library", "Logs")) {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => PROCESS_LOG.test(n));
  } catch {
    return [];
  }
  return names.filter((n) => {
    const path = join(dir, n);
    try {
      const at = lstatSync(path, { throwIfNoEntry: false });
      // Mostly holes: a writer that doesn't append wrote on past an earlier truncate (an app not rebuilt since); its
      // own restart rotates it.
      if (
        !at?.isFile() ||
        at.size <= LOG_CAP ||
        at.blocks * 512 < at.size / 2
      ) {
        return false;
      }
      copyFileSync(path, join(dir, n.replace(LOG_END, ".old.log")));
      truncateSync(path, 0);
      return true;
    } catch (e) {
      log("run.error", { ...errorOf(e), file: n, step: "watch.logs" });
      return false;
    }
  });
}
