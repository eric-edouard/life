import { readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { LIFE_STATE_DIR, TEST } from "./paths";

// The differences between the systems Life runs on (macOS, Windows) that it handles so far, in one place, so a new
// system is one more case here rather than a branch in every module (the rest are listed in
// docs/plans/2026-10-22-platforms.md). Linux is not a target. Sources that exist only on the Mac say so in their
// descriptor (`macOnly`); their stores' paths stay with their readers.

export const WINDOWS = process.platform === "win32";

/** A relative path with `/` between its parts, as git, an export and a test name it on every system. */
export const slashed = (p: string) => p.split(sep).join("/");

/**
 * The home folder every store path starts from. A test run has one of its own, inside its copy of the data, so no test
 * ever reads this computer's messages, mail, contacts or repos.
 */
export const HOME = TEST ? join(LIFE_STATE_DIR, "home") : homedir();
/** A Windows folder its variable names, else its default under `HOME`; a test run's is always under its own `HOME`. */
const winDir = (name: string, ...parts: string[]) =>
  (TEST ? undefined : process.env[name]) ?? join(HOME, ...parts);
/** Where apps keep their own data: Application Support on the Mac, roaming AppData on Windows. */
export const APP_DATA = WINDOWS
  ? winDir("APPDATA", "AppData", "Roaming")
  : join(HOME, "Library", "Application Support");

/**
 * Life's folder on this computer, shared by every install on it (the checkout's and the app's): the archive, Codex's
 * home, the backup's staging and the services' locks. Local AppData on Windows: it is never synced to another PC.
 */
export const MACHINE_DIR = WINDOWS
  ? join(winDir("LOCALAPPDATA", "AppData", "Local"), "Life")
  : join(APP_DATA, "Life");

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
/** This process's `MODEL_ENV` variables: what a CLI Life starts gets, and nothing else. */
export const cliEnv = () =>
  Object.fromEntries(
    MODEL_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))
  );

/** The system's own time zone: on the Mac whatever TZ the process runs with; on Windows `Intl`'s, which follows TZ when set. */
export const systemZone = (): string | undefined =>
  WINDOWS
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : readlinkSync("/etc/localtime").split("zoneinfo/")[1];

/**
 * The command that shows a notification, or none where Life has no way to show one yet (Windows: none yet). On
 * the Mac the title and body are the script's arguments, never quoted into its text, so no word of theirs can break it.
 */
export const notifyArgs = (title: string, body: string) =>
  WINDOWS
    ? undefined
    : [
        "osascript",
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ];
