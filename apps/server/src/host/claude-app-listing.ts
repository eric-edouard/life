import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { APP_DATA, HOME } from "../core/platform";

// Which Claude Code sessions his Claude app lists, and which sit in its "Life Agents" group: read from the app's own
// files, read-only, for the agents' health (`agentHealthOf`). The app's files are its own, undocumented format: a file
// it no longer writes so says nothing (null), never "not listed". Also whether the Life plugin is on in Claude Code.
// ponytail: the app's folder under Application Support (`Claude`); a second Claude app with a folder of its own is not read.

const APP = join(APP_DATA, "Claude");
/** One file per session the app lists (`local_<id>.json`), its `cliSessionId` near its start. */
const SESSIONS = join(APP, "claude-code-sessions");
const CONFIG = join(APP, "claude_desktop_config.json");
/** The group his agents' sessions are filed in (the session that set it up named it). */
export const AGENTS_GROUP = "Life Agents";
/** How much of a session file holds its ids: they are its first keys; the files are large (their transcripts' summaries). */
const HEAD_BYTES = 1024;

const CLI_ID = /"cliSessionId":"([^"]+)"/;
const CODE_PREFIX = /^code:/;

/** Each listed file's Claude Code session id, by path: a file's ids never change, so each is read once per process. */
const cliIdOf = new Map<string, string>();

const cliIdIn = (path: string) => {
  const buf = Buffer.alloc(HEAD_BYTES);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, HEAD_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  return CLI_ID.exec(buf.toString("utf8"))?.[1] ?? null;
};

/** The app's local ids by Claude Code session id (`local_<id>` names its file). */
function readListed() {
  const byCli = new Map<string, string>();
  const inside = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return []; // a file beside the folders (.DS_Store)
    }
  };
  for (const scope of inside(SESSIONS)) {
    for (const inner of inside(join(SESSIONS, scope))) {
      for (const name of inside(join(SESSIONS, scope, inner))) {
        if (!(name.startsWith("local_") && name.endsWith(".json"))) {
          continue;
        }
        const path = join(SESSIONS, scope, inner, name);
        // Only an id found is kept: a file read while the app writes it is read again next time.
        const cli = cliIdOf.get(path) ?? cliIdIn(path);
        if (cli) {
          cliIdOf.set(path, cli);
          byCli.set(cli, name.slice(0, -".json".length));
        }
      }
    }
  }
  return byCli;
}

interface GroupScope {
  assignments?: Record<string, string>;
  groups?: { id: string; name: string }[];
}

/** The local ids filed in the `AGENTS_GROUP` group, of every scope; none when it has no such group. */
function readInGroup() {
  const prefs = JSON.parse(readFileSync(CONFIG, "utf8"))?.preferences
    ?.epitaxyPrefs?.["dframe-group-scopes"] as
    | Record<string, GroupScope>
    | undefined;
  const filed = new Set<string>();
  for (const scope of Object.values(prefs ?? {})) {
    const group = scope.groups?.find((g) => g.name === AGENTS_GROUP)?.id;
    for (const [key, id] of Object.entries(scope.assignments ?? {})) {
      if (group && id === group) {
        filed.add(key.replace(CODE_PREFIX, ""));
      }
    }
  }
  return filed;
}

/** Where session `ref` stands in his Claude app. */
export interface AppListing {
  inGroup: boolean;
  listed: boolean;
}

/**
 * How his Claude app lists Claude Code sessions, as a lookup by session id; null when its files can't be read (no app,
 * another layout): nothing is judged then.
 */
export function readClaudeAppListing(): ((ref: string) => AppListing) | null {
  if (!existsSync(SESSIONS)) {
    return null;
  }
  try {
    const listed = readListed();
    const inGroup = readInGroup();
    return (ref) => {
      const local = listed.get(ref);
      return { inGroup: local ? inGroup.has(local) : false, listed: !!local };
    };
  } catch {
    return null;
  }
}

/** Whether the Life plugin is on in Claude Code (`enabledPlugins` in his `~/.claude/settings.json`); unreadable: not said. */
export function readIsLifePluginOn() {
  try {
    const s = JSON.parse(
      readFileSync(join(HOME, ".claude", "settings.json"), "utf8")
    );
    return s?.enabledPlugins?.["life@life"] === true;
  } catch {
    // unreadable: not said
  }
}
