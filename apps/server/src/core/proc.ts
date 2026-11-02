// Running other programs: one process to its end, one line from a server, or one git command.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { MIN } from "./clock";

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

/** One git command in the repo at `path`, synchronously. */
export const git = (path: string, args: string[]) =>
  Bun.spawnSync(["git", "-C", path, ...args], {
    stderr: "pipe",
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
    throw new Error(`git ${args[0]}: ${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString().trim();
}

/** The code the checkout at `root` holds (its committed apps/server/src/, prompts/ and assets/, the pages it serves): an always-on service exits when it changes, and launchd starts the new code. */
export const codeAt = (root: string) =>
  git(root, [
    "rev-parse",
    "HEAD:apps/server/src",
    "HEAD:prompts",
    "HEAD:assets",
  ]).stdout.toString();

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
