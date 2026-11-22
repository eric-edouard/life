// His own Claude `PreToolUse` command hooks, run by Life's pi extension (`pi-extension.ts`) before each shell call of an
// agent of his own Life, after Life's send guard, as Claude Code runs them: the call as Claude's hook JSON on stdin, each
// hook's timeout; exit 2, or a JSON deny or block on exit 0, refuses the call with the hook's reason. A hook that fails
// otherwise or times out lets the call through, as in Claude: Life's own guard is the one that fails closed. ponytail:
// shell calls only (his `Edit|Write` and MCP hooks do not run on pi), one hook after another, no `updatedInput`.

/** His Claude hooks as `~/.claude/settings.json` holds them under `hooks.PreToolUse`. */
export interface ClaudeHookGroup {
  hooks: { command: string; timeout?: number; type: string }[];
  matcher?: string;
}

/** How long a hook's output is read once it exited (a child it left may hold its pipes open). */
const READ_AFTER_EXIT_MS = 500;

/** Whether `matcher` takes `tool`: Claude's `*` or none takes every tool; an invalid pattern takes none. */
const isMatchOf = (matcher: string | undefined, tool: string) => {
  if (!matcher || matcher === "*") {
    return true;
  }
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
};

/** Why his hooks refuse `call`, or none: each matching command hook, in order, until one refuses. */
export async function runClaudeHooks(
  groups: ClaudeHookGroup[],
  call: { cwd: string; tool_input: unknown; tool_name: string }
) {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", ...call });
  for (const g of groups.filter((x) => isMatchOf(x.matcher, call.tool_name))) {
    for (const h of g.hooks.filter((x) => x.type === "command")) {
      // biome-ignore lint/performance/noAwaitInLoops: Claude runs a tool's hooks before it, each its verdict
      const why = await runHook(h.command, input, h.timeout ?? 60);
      if (why) {
        return why;
      }
    }
  }
}

/** A stream's text as far as it came within `READ_AFTER_EXIT_MS`. */
const readSoon = (s: ReadableStream<Uint8Array>) =>
  Promise.race([
    new Response(s).text(),
    Bun.sleep(READ_AFTER_EXIT_MS).then(() => ""),
  ]);

async function runHook(command: string, input: string, seconds: number) {
  const p = Bun.spawn(["sh", "-c", command], {
    stderr: "pipe",
    stdin: new Blob([input]),
    stdout: "pipe",
    timeout: seconds * 1000,
  });
  const code = await p.exited;
  const [out, err] = await Promise.all([
    readSoon(p.stdout),
    readSoon(p.stderr),
  ]);
  if (code === 2) {
    return err.trim() || "refused by his hook";
  }
  return code === 0 ? jsonRefusalOf(out) : undefined;
}

/** A hook's JSON answer's refusal (`permissionDecision: "deny"`, `decision: "block"`), or none. */
function jsonRefusalOf(out: string) {
  try {
    const o = JSON.parse(out) as {
      decision?: string;
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
      reason?: string;
    };
    if (
      o.hookSpecificOutput?.permissionDecision === "deny" ||
      o.decision === "block"
    ) {
      return (
        o.hookSpecificOutput?.permissionDecisionReason ??
        o.reason ??
        "refused by his hook"
      );
    }
  } catch {
    // no JSON: the exit code was the hook's answer
  }
}
