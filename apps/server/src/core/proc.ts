// Running other programs: one process to its end, one started and left to run, one line from a server, or one git
// command.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { MIN } from "./clock";
import { log } from "./log";
import { cliEnv, HAS_LOGIN_SHELL } from "./platform";
import { readSettings } from "./settings";

/**
 * Runs `cmd` to its end: its exit code, output, and the signal that killed it (SIGTERM after `timeout` ms), if any.
 * A program that cannot start (not on PATH) exits -1 with the reason, like any failure.
 */
export async function exec(
  cmd: string[],
  o: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: string;
    timeout?: number;
  } = {}
) {
  let proc: Bun.Subprocess<Blob | undefined, "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, {
      cwd: o.cwd,
      env: o.env,
      stderr: "pipe",
      stdin: o.stdin === undefined ? undefined : new Blob([o.stdin]),
      stdout: "pipe",
      timeout: o.timeout ?? MIN,
    });
  } catch (e) {
    return { code: -1, killed: null, stderr: (e as Error).message, stdout: "" };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, killed: proc.signalCode, stderr, stdout };
}

/** `exec` for a step that must work: its output, or an error with what it said, named by its first two words. */
export async function execOk(
  cmd: string[],
  o: Parameters<typeof exec>[1] = {}
) {
  const r = await exec(cmd, o);
  if (r.code !== 0) {
    throw new Error(
      `${cmd.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim().slice(-800)}`
    );
  }
  return r.stdout;
}

/**
 * The program the desk launches for a CLI: found on the PATH as it is now (`cliEnv`), less any `node_modules/.bin` (where
 * `bun run` puts Life's own pinned Codex, which is not his); the bare name when none is found.
 */
export function readProgram(name: string) {
  const path = (cliEnv().PATH ?? "")
    .split(":")
    .filter((d) => !d.endsWith("node_modules/.bin"))
    .join(":");
  return Bun.which(name, { PATH: path }) ?? name;
}

/**
 * Runs `cmd` with `input` on its stdin, kept open (a server that quits at the end of its input before answering), to
 * the first whole line of its output that `done` accepts: that line, or undefined when it exits, refuses its input,
 * `done` throws or `timeout` ms pass first. It is killed either way.
 */
export async function firstLine(
  cmd: string[],
  input: string,
  done: (line: string) => boolean,
  o: { env?: Record<string, string>; timeout?: number } = {}
) {
  let proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    proc = Bun.spawn(cmd, {
      env: o.env,
      stderr: "ignore",
      stdin: "pipe",
      stdout: "pipe",
      timeout: o.timeout ?? MIN,
    });
  } catch {
    return;
  }
  let out = "";
  try {
    // Awaited, so a server gone before reading (EPIPE) rejects here, not as an unhandled error.
    await proc.stdin.write(input);
    await proc.stdin.flush();
    for await (const chunk of proc.stdout.pipeThrough(
      new TextDecoderStream()
    )) {
      out += chunk;
      const line = out.split("\n").slice(0, -1).find(done);
      if (line !== undefined) {
        return line;
      }
    }
  } catch {
    // No answer.
  } finally {
    proc.kill();
  }
}

/** One git command in the repo at `path`, synchronously, `stdin` on its input. */
export const git = (path: string, args: string[], stdin?: string) =>
  Bun.spawnSync(["git", "-C", path, ...args], {
    stderr: "pipe",
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    stdout: "pipe",
  });

/**
 * The checkout's files under `dirs` ending in one of `ends`, tracked or new (not ignored, not deleted), named with `/`:
 * what the whole-code tests scan, without walking the folders themselves.
 */
export const repoFiles = (root: string, dirs: string[], ends: string[]) =>
  gitOut(root, [
    "ls-files",
    // NUL-separated: git would quote a name with non-ASCII letters, and the scan would silently skip it.
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...dirs,
  ])
    .split("\0")
    .filter(
      (f) => ends.some((e) => f.endsWith(e)) && existsSync(join(root, f))
    );

/** `git` that throws on a failure; its output, trimmed. */
export function gitOut(path: string, args: string[]) {
  const r = git(path, args);
  if (r.exitCode !== 0) {
    // Named by its command, past any global option.
    const command = args.find((x) => !x.startsWith("-"));
    throw new Error(`git ${command}: ${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString().trim();
}

/**
 * Commits `paths` (relative to the repo at `repo`, each taken literally, never as a pattern) alone, when any changed:
 * their new, changed and deleted files (a tracked folder gone whole included, staged by `git rm` or not), and nothing
 * else staged there.
 */
export function commitPaths(repo: string, paths: string[], message: string) {
  const literal = (args: string[]) =>
    gitOut(repo, ["--literal-pathspecs", ...args]);
  const isKnown = (p: string) =>
    existsSync(join(repo, p)) || literal(["ls-files", "--", p]) !== "";
  // In the last commit only: removed from the disk and the index already (`git rm`); none before a first commit.
  const isInHead = (p: string) =>
    git(repo, [
      "--literal-pathspecs",
      "ls-tree",
      "--name-only",
      "HEAD",
      "--",
      p,
    ])
      .stdout.toString()
      .trim() !== "";
  const added = paths.filter(isKnown);
  const kept = paths.filter((p) => added.includes(p) || isInHead(p));
  if (kept.length === 0) {
    return;
  }
  if (added.length > 0) {
    literal(["add", "-A", "--", ...added]);
  }
  if (literal(["status", "--porcelain", "--", ...kept])) {
    literal(["commit", "-m", message, "--", ...kept]);
  }
}

/** The code the checkout at `root` holds (its committed apps/server/src/, prompts/ and assets/, the pages it serves): an always-on service exits when it changes, and launchd starts the new code. */
export const codeAt = (root: string) =>
  git(root, [
    "rev-parse",
    "HEAD:apps/server/src",
    "HEAD:prompts",
    "HEAD:assets",
  ]).stdout.toString();

/**
 * What a kept process runs: its code and the sources he turned on, read afresh. The archive and the watcher end when it
 * changes, and the app starts them again: a network linked from his phone or the CLI is copied with no Restart.
 */
export const readRunning = (root: string) =>
  `${codeAt(root)}${readSettings().sources.join(",")}`;

/** What `probe` gives once it gives anything, tried once a second, `tries` times at most; else throws `what` isn't answering. */
export async function untilAnswers<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  tries = 30
): Promise<T> {
  for (const _ of Array.from({ length: tries })) {
    // biome-ignore lint/performance/noAwaitInLoops: once a second, until it answers
    const answer = await probe().catch(() => undefined);
    if (answer !== undefined) {
      return answer;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`${what} isn't answering`);
}

const LOGIN_MARK = "LIFE_LOGIN_ENV_MARK";
const loginEnvs = new Map<string, Record<string, string>>();

/**
 * The environment of his login shell (his keys, his PATH), read by running it interactive and login: `env -0` between
 * two markers, so a profile's own output never mixes in. Only an agent of his own Life is given it (`runtime-rows.ts`).
 * A failure gives `{}` and is logged without a value, and is tried again next time. Values are never logged or stored.
 * ponytail: read once per desk process, so a change to his shell profile takes effect at the desk's next start;
 * upgrade path: read again when the profile's mtime changes.
 */
export async function readLoginEnv(shell = process.env.SHELL ?? "/bin/zsh") {
  const known = loginEnvs.get(shell);
  if (known || !HAS_LOGIN_SHELL) {
    return known ?? {};
  }
  const r = await exec(
    [shell, "-ilc", `printf ${LOGIN_MARK}; env -0; printf ${LOGIN_MARK}`],
    { env: cliEnv(), timeout: 15_000 }
  );
  const [, body] = r.stdout.split(LOGIN_MARK);
  if (r.code !== 0 || body === undefined) {
    log("desk.runtime", { code: r.code, ok: false, what: "login-env" });
    return {};
  }
  const env: Record<string, string> = {};
  for (const entry of body.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) {
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }
  loginEnvs.set(shell, env);
  return env;
}
