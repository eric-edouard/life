// Installs (or replaces) a LaunchAgent that runs `bun src/cli.ts <args>` in this checkout:
// `bun scripts/install.ts <archive|watch|memory-nightly>`. Safe to repeat; run it from the checkout that should run it.
import { homedir } from "node:os";
import { join } from "node:path";

const ALWAYS_ON =
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>";

// `when` is the plist's scheduling keys. The archive and the watcher stay on; the nightly starts every 30 minutes and
// memory/guard.ts lets it run the night once, after 02:00,
// a midday pass once after 13:00 and once after 19:00, and the backup once the night is done (or from 06:00).
const JOBS: Record<string, { args: string[]; log: string; when: string }> = {
  archive: { args: ["archive"], log: "life-archive.log", when: ALWAYS_ON },
  "memory-nightly": {
    args: ["memory", "nightly"],
    log: "life-memory.log",
    when: "<key>StartInterval</key><integer>1800</integer><key>RunAtLoad</key><true/>",
  },
  watch: { args: ["watch"], log: "life-watch.log", when: ALWAYS_ON },
};

const name = process.argv[2] ?? "";
const job = JOBS[name];
if (!job) {
  console.error(
    `usage: bun scripts/install.ts <${Object.keys(JOBS).join("|")}>`
  );
  process.exit(1);
}

// launchd starts with a bare PATH; runs need `claude`, `bun` and `restic`.
const path = [
  join(homedir(), ".local/bin"),
  join(homedir(), ".bun/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");
const label = `com.ericedouard.life.${name}`;
const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const log = join(homedir(), "Library/Logs", job.log);
const domain = `gui/${process.getuid?.()}`;
const program = [process.execPath, "src/cli.ts", ...job.args]
  .map((a) => `<string>${a}</string>`)
  .join("");
await Bun.write(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${program}</array>
  <key>WorkingDirectory</key><string>${join(import.meta.dir, "..")}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>
  ${job.when}
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`
);
// bootout fails when the job is not loaded yet; that is fine.
await Bun.$`launchctl bootout ${domain}/${label}`.nothrow().quiet();
// Installing means turning on: a job disabled earlier refuses to bootstrap until it is enabled.
await Bun.$`launchctl enable ${domain}/${label}`;
await Bun.$`launchctl bootstrap ${domain} ${plist}`;
console.log(`installed ${plist}`);
