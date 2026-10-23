import { readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Engine } from "./names";
import { LIFE_STATE_DIR, TEST } from "./paths";

// The differences between the systems Life runs on (macOS, Windows, and Linux for a server) that it handles so far, in
// one place, so a new system is one more case here rather than a branch in every module (the rest are listed in
// docs/plans/2026-10-22-platforms.md). Sources that exist only on the Mac say so in their descriptor (`macOnly`); their
// stores' paths stay with their readers. What only the Mac has (notifications, launchd) is simply absent elsewhere.

export const MAC = process.platform === "darwin";
export const WINDOWS = process.platform === "win32";

/** How Life's status names the machine it runs on: its group, its card, since when it is up, where a service runs. */
export const MACHINE = (() => {
  if (MAC) {
    return {
      card: "MacBook",
      group: "The Mac",
      up: "Awake since",
      where: "on the Mac",
    };
  }
  return WINDOWS
    ? { card: "PC", group: "This PC", up: "Up since", where: "on this PC" }
    : {
        card: "Server",
        group: "The server",
        up: "Up since",
        where: "on the server",
      };
})();

/** A relative path with `/` between its parts, as git, an export and a test name it on every system. */
export const slashed = (p: string) => p.split(sep).join("/");

/**
 * The home folder every store path starts from. A test run has one of its own, inside its copy of the data, so no test
 * ever reads this computer's messages, mail, contacts or repos.
 */
export const HOME = TEST ? join(LIFE_STATE_DIR, "home") : homedir();
/** A folder its variable names, else its default under `HOME`; a test run's is always under its own `HOME`. */
const envDir = (name: string, ...parts: string[]) =>
  (TEST ? undefined : process.env[name]) ?? join(HOME, ...parts);
/** Where apps keep their own data: Application Support on the Mac, roaming AppData on Windows, XDG's data home on Linux. */
export const APP_DATA = (() => {
  if (MAC) {
    return join(HOME, "Library", "Application Support");
  }
  return WINDOWS
    ? envDir("APPDATA", "AppData", "Roaming")
    : envDir("XDG_DATA_HOME", ".local", "share");
})();

/**
 * Life's folder on this computer, shared by every install on it (the checkout's and the app's): the archive, Codex's
 * home, the backup's staging and the services' locks. Local AppData on Windows: it is never synced to another PC.
 */
export const MACHINE_DIR = WINDOWS
  ? join(envDir("LOCALAPPDATA", "AppData", "Local"), "Life")
  : join(APP_DATA, "Life");

/** The command that opens an app hidden in the background, or none where Life opens no apps (only the Mac does). */
export const openAppArgs = MAC
  ? (app: string) => ["open", "-g", "-j", "-a", app]
  : undefined;

/** The command that restarts the Mac's Cloudflare tunnel (its LaunchAgent); none elsewhere, where its own supervisor does. */
export const TUNNEL_RESTART = MAC
  ? [
      "launchctl",
      "kickstart",
      "-k",
      `gui/${process.getuid?.()}/com.eric.cloudflared`,
    ]
  : undefined;

/**
 * When process `pid` started, as the system counts it (Linux's /proc: ticks since boot), to tell one process from a
 * later one with the same pid; undefined where the system doesn't say (the Mac, Windows) or there is no such process.
 */
export function startTicks(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // After the command's closing parenthesis: the state is field 3, the start time field 22.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    // No /proc, or no such process.
  }
}

/** The engine an install runs with until he picks one: his subscriptions on a Mac or a PC, OpenRouter on a server. */
export const HOST_ENGINE: Engine = MAC || WINDOWS ? "claude" : "openrouter";

/** The pinned codex's native binary for this system, under Life's files (`node_modules`, or the app's helper). */
export const CODEX = (() => {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const systems: Partial<Record<NodeJS.Platform, string>> = {
    linux: "unknown-linux-musl",
    win32: "pc-windows-msvc",
  };
  const system = systems[process.platform] ?? "apple-darwin";
  const exe = WINDOWS ? "codex.exe" : "codex";
  const pkg = `codex-${process.platform}-${process.arch}`;
  return `node_modules/@openai/${pkg}/vendor/${arch}-${system}/bin/${exe}`;
})();

/**
 * The environment a model CLI needs to run, by name: the Unix ones and Windows' own (absent ones are skipped). No API
 * key and none of Life's secrets.
 */
export const MODEL_ENV = [
  ..."HOME LANG LC_ALL LOGNAME PATH SHELL TERM TMPDIR USER".split(" "),
  ..."APPDATA LOCALAPPDATA PATHEXT SystemRoot TEMP TMP USERPROFILE".split(" "),
];

/**
 * The owner's zone as this computer knows it: on the Mac whatever TZ the process runs with; on Windows `Intl`'s, which
 * follows TZ when set. A server's own zone is not his: on Linux only a TZ set for Life counts, else none.
 */
export const systemZone = (): string | undefined => {
  if (MAC) {
    return readlinkSync("/etc/localtime").split("zoneinfo/")[1];
  }
  return WINDOWS
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : process.env.TZ || undefined;
};

/**
 * The command that shows a notification, or none where Life has no way to show one (only the Mac has one). The title
 * and body are the script's arguments, never quoted into its text, so no word of theirs can break it.
 */
export const notifyArgs = (title: string, body: string) =>
  MAC
    ? [
        "osascript",
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ]
    : undefined;
