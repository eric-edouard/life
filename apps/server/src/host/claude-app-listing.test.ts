import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DATA } from "../core/platform";
import { readClaudeAppListing } from "./claude-app-listing";

// How the Claude app lists sessions, from made-up files in the test's own Application Support: a session listed and
// filed in "Life Agents", one listed only, one not listed; no app folder says nothing.

const APP = join(APP_DATA, "Claude");

test("listed and filed in Life Agents, listed only, not listed; no app: not judged", () => {
  rmSync(APP, { force: true, recursive: true });
  expect(readClaudeAppListing()).toBeNull();
  const dir = join(APP, "claude-code-sessions", "acct", "org");
  mkdirSync(dir, { recursive: true });
  const session = (local: string, cli: string) =>
    writeFileSync(
      join(dir, `local_${local}.json`),
      JSON.stringify({
        cliSessionId: cli,
        sessionId: `local_${local}`,
        title: "x".repeat(4000),
      })
    );
  session("a1", "cli-filed");
  session("b2", "cli-listed");
  writeFileSync(
    join(APP, "claude_desktop_config.json"),
    JSON.stringify({
      preferences: {
        epitaxyPrefs: {
          "dframe-group-scopes": {
            "acct/org": {
              assignments: { "code:local_a1": "cg-1", "code:local_b2": "cg-2" },
              groups: [
                { id: "cg-2", name: "Other" },
                { id: "cg-1", name: "Life Agents" },
              ],
            },
          },
        },
      },
    })
  );
  const of = readClaudeAppListing();
  expect([of?.("cli-filed"), of?.("cli-listed"), of?.("cli-none")]).toEqual([
    { inGroup: true, listed: true },
    { inGroup: false, listed: true },
    { inGroup: false, listed: false },
  ]);
  rmSync(APP, { force: true, recursive: true });
});
