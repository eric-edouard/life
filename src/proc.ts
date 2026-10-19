// Running other programs: one process to its end, or one git command.

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
      timeout: o.timeout ?? 60_000,
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

/** One git command in the repo at `path`, synchronously. */
export const git = (path: string, args: string[]) =>
  Bun.spawnSync(["git", "-C", path, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });

/** The code the checkout at `root` holds (its committed src/ and prompts/): an always-on service exits when it changes, and launchd starts the new code. */
export const codeAt = (root: string) =>
  git(root, ["rev-parse", "HEAD:src", "HEAD:prompts"]).stdout.toString();
