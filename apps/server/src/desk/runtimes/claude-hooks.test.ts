import { expect, test } from "bun:test";
import { runClaudeHooks } from "./claude-hooks";

const call = { cwd: "/tmp", tool_input: { command: "ls" }, tool_name: "Bash" };
const hook = (command: string, matcher?: string, timeout?: number) => ({
  hooks: [{ command, timeout, type: "command" }],
  matcher,
});

test("his hooks run as Claude's: `*` or none matches every tool, an invalid pattern none; exit 2 and a JSON deny refuse", async () => {
  const deny = `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no ls"}}'`;
  expect(await runClaudeHooks([hook(deny, "*")], call)).toBe("no ls");
  expect(await runClaudeHooks([hook(deny)], call)).toBe("no ls");
  expect(
    await runClaudeHooks([hook(deny, "Edit|Write")], call)
  ).toBeUndefined();
  expect(await runClaudeHooks([hook(deny, "*(")], call)).toBeUndefined();
  expect(
    await runClaudeHooks(
      [hook("grep -q '\"ls\"' && { echo stop >&2; exit 2; }", "Bash")],
      call
    )
  ).toBe("stop");
  // Another exit is the hook failing: the call goes through, as in Claude.
  expect(
    await runClaudeHooks([hook(`${deny}; exit 1`, "Bash")], call)
  ).toBeUndefined();
});

test("a hook past its timeout lets the call through, even when a child it left holds its output open", async () => {
  const at = performance.now();
  expect(
    await runClaudeHooks([hook("sleep 5 | cat", "Bash", 1)], call)
  ).toBeUndefined();
  expect(performance.now() - at).toBeLessThan(3000);
});
