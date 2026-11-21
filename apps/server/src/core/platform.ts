import { existsSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  OWNER_DATA_DIR,
  real,
  TEST,
} from "./paths";

// The differences between the systems Life runs on (macOS, Windows) that it handles so far, in one place, so a new
// system is one more case here rather than a branch in every module (the rest are listed in
// docs/plans/2026-10-22-platforms.md). Linux is not a target. Sources that exist only on the Mac say so in their
// descriptor (`macOnly`); their stores' paths stay with their readers.

export const WINDOWS = process.platform === "win32";

/** A relative path with `/` between its parts, as git, an export and a test name it on every system. */
export const slashed = (p: string) => p.split(sep).join("/");

/**
 * `path` relative to `root` when it sits inside it (`""` for `root` itself), else null: above it, or on another Windows
 * drive, where `relative` gives an absolute path. `paths` is this system's; a test passes `win32`.
 */
export function pathInside(
  root: string,
  path: string,
  paths = { isAbsolute, relative, sep }
) {
  const r = paths.relative(root, path);
  // Above it is `..` as a whole part: `..agents` is a child.
  return r === ".." || r.startsWith(`..${paths.sep}`) || paths.isAbsolute(r)
    ? null
    : r;
}

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

/** Life.app's own folder on this computer: its data, its state, the archive, Codex's home, the backup's staging and the services' locks. Local AppData on Windows: it is never synced to another PC. */
const APP_MACHINE_DIR = WINDOWS
  ? join(winDir("LOCALAPPDATA", "AppData", "Local"), "Life")
  : join(APP_DATA, "Life");
/** Life.app's own data and state folders (`Helper.swift` passes them to every helper). */
export const APP_FOLDERS = {
  data: join(APP_MACHINE_DIR, "data"),
  state: join(APP_MACHINE_DIR, "state"),
};

/** Is `state` the app's own state, which a checkout never rewrites (the app may be running on it): a store step skips it. */
export const isAppState = (state: string) =>
  existsSync(join(LIFE_CODE_DIR, ".git")) &&
  real(state) === real(APP_FOLDERS.state);

/**
 * Is `data` his own Life, not a second Life beside it (a demo, a copy to experiment on, a test's): the app's data folder,
 * or `~/Life` (a checkout's default). What only a second Life may take (`LIFE_LLM`, `LIFE_MACHINE_DIR`, `LIFE_PORT`)
 * or must not have (a desk agent's run as he set Claude up) asks this.
 */
export const isOwnLife = (data = OWNER_DATA_DIR) =>
  [APP_FOLDERS.data, join(homedir(), "Life")].some(
    (p) => real(p) === real(data)
  );

/**
 * Life's folder on this computer, shared by every install on it (the checkout's and the app's). `LIFE_MACHINE_DIR`
 * gives a second Life its own, so it takes none of the app's locks; never with his own data.
 */
export const MACHINE_DIR = (() => {
  const set = process.env.LIFE_MACHINE_DIR;
  if (set && isOwnLife()) {
    throw new Error(
      "LIFE_MACHINE_DIR is for a second Life, never his own data"
    );
  }
  return set ?? APP_MACHINE_DIR;
})();

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
/** Whether this system has a login shell whose environment can be read (`readLoginEnv`): the Mac; Windows has none. */
export const HAS_LOGIN_SHELL = !WINDOWS;

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

/** llama.cpp's server, for the describer: the app's bundled one (`LIFE_LLAMA_SERVER`), else the one on PATH (a checkout). */
export const llamaServer = () =>
  process.env.LIFE_LLAMA_SERVER ?? Bun.which("llama-server");

/** Google Chrome, for a bridge's sign-in window (`host/sign-in-browser.ts`): the Mac's; none elsewhere. */
export const CHROME = WINDOWS
  ? undefined
  : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
