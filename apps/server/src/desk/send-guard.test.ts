import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_POST_SIGNATURE } from "../core/names";
import { CODEX } from "../core/platform";
import { exec } from "../core/proc";
import { readCodexGuardTrust } from "./runtimes/runtime-rows";
import { SEND_GUARD_HOOK, sendRefusalOf, type ToolCall } from "./send-guard";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

// The send guard over a table of made-up tool calls: each kind of send refused, reads, drafts and his own mail let through.

const facts = {
  ownAddresses: ["owner@example.com", "owner@work.example"],
  postRepos: ["acme/hub"],
};
const bash = (command: string): ToolCall => ({
  tool_input: { command },
  tool_name: "Bash",
});
const mcp = (name: string, input: unknown = {}): ToolCall => ({
  tool_input: input,
  tool_name: `mcp__${name}`,
});

const REFUSED: [string, ToolCall][] = [
  ...[
    "claude_ai_Life__answer_check",
    "2dc4e169_2994__request_decision",
    "x__change_directory_entry",
    "x__change_registered_agent",
    "x__change_todo_item",
    "x__correct_memory",
    "x__tell_life",
    // A server id holding `__` is not the door, however it starts.
    "desk__x__request_decision",
    // Codex's shortened names (`<what is left>_<12 hex>`): a write cut to fit, told apart from a twin, or cut whole.
    "codex_apps__a_long_life_connector_name__change_registe_0123456789ab",
    "codex_apps__life__tell_life_abcdef012345",
    "codex_apps__a_very_long_connector_name_cut_short__0123456789ab",
  ].map((n): [string, ToolCall] => [`his connector's write ${n}`, mcp(n)]),
  ["a mail connector's send", mcp("0f00__send_message", { to: ["a@b.co"] })],
  ["a mail connector's reply", mcp("0f00__reply", { body: "ok" })],
  ["a mail connector's forward", mcp("0f00__forward")],
  ["Codex's Gmail plugin send", mcp("codex_apps__gmail_send_email")],
  ["Beeper's send", mcp("beeper__send_message", { chatID: "x" })],
  ["an answer to an invitation", mcp("cal__respond_to_event")],
  [
    "an event inviting someone",
    mcp("cal__create_event", { attendees: ["friend@example.org"] }),
  ],
  [
    "an event update inviting someone",
    mcp("cal__update_event", { attendees: [{ email: "friend@example.org" }] }),
  ],
  [
    "a browser opening WhatsApp",
    mcp("claude-in-chrome__navigate", { url: "https://web.whatsapp.com/" }),
  ],
  [
    "a browser opening Gmail",
    mcp("playwriter__execute", {
      code: "page.goto('https://mail.google.com')",
    }),
  ],
  ["a shell opening a DM", bash("open https://www.instagram.com/direct/t/1")],
  [
    "computer use on Messages",
    mcp("computer-use__app_type", { app: "Messages" }),
  ],
  ["agent-desktop on WhatsApp", bash("agent-desktop type --app WhatsApp hi")],
  ["gog's mail send", bash("gog --account x gmail send --to a@b.co --body hi")],
  [
    "gog's mail reply",
    bash("gog --account x gmail reply --thread t --body ok"),
  ],
  ["gog's mail forward", bash("gog gmail forward --id m --to a@b.co")],
  [
    "gog's event with attendees",
    bash("gog calendar create --attendees friend@example.org --title t"),
  ],
  [
    "resend to a display name",
    bash(
      'resend emails send --to "Bob <bob@example.org>" --from a@send.example'
    ),
  ],
  [
    "resend to a list after one of his",
    bash("resend emails send --to owner@example.com bob@example.org"),
  ],
  [
    "a signed post chained to an unlisted repo",
    bash(
      `gh issue comment 1 --repo acme/hub --body "x\n${AGENT_POST_SIGNATURE}" && gh issue comment 2 --repo other/x --body hi`
    ),
  ],
  ["imsg", bash("imsg send --to +15550100 'hi'")],
  [
    "osascript telling Messages to send",
    bash(
      `osascript -e 'tell application "Messages" to send "hi" to buddy "x"'`
    ),
  ],
  [
    "resend to someone else",
    bash("resend emails send --to friend@example.org --from a@send.example"),
  ],
  [
    "resend to him and someone else",
    bash("resend emails send --to owner@example.com,friend@example.org"),
  ],
  [
    "resend with no recipient named",
    bash("resend emails send --file mail.json"),
  ],
  [
    "a comment on a repo not listed",
    bash(
      `gh issue comment 3 --repo other/repo --body "x\n${AGENT_POST_SIGNATURE}"`
    ),
  ],
  [
    "a comment with no repo named",
    bash(`gh issue comment 3 --body "x\n${AGENT_POST_SIGNATURE}"`),
  ],
  ["a comment unsigned", bash(`gh pr comment 3 --repo acme/hub --body "x"`)],
  [
    "a comment from a file",
    bash("gh issue create --repo acme/hub --title t --body-file b.md"),
  ],
];

const LET_THROUGH: [string, ToolCall][] = [
  ["a mail search", mcp("0f00__search_threads", { query: "from:x" })],
  ["a draft", mcp("0f00__create_draft", { body: "hi", to: ["a@b.co"] })],
  ["an event of his own", mcp("cal__create_event", { summary: "Gym" })],
  [
    "an event with him only",
    mcp("cal__create_event", { attendees: ["owner@work.example"] }),
  ],
  ["his connector's read", mcp("claude_ai_Life__read_inbox")],
  [
    "his connector's read, shortened by Codex",
    mcp("codex_apps__a_long_life_connector_name__read_matt_0123456789ab"),
  ],
  ["Life's own card", mcp("desk__request_decision", { question: "Send?" })],
  [
    "a web page",
    mcp("claude-in-chrome__navigate", { url: "https://example.com" }),
  ],
  ["computer use on Notes", mcp("computer-use__app_type", { app: "Notes" })],
  ["a command", bash("ls ~/Documents && git status")],
  ["gog reading mail", bash("gog --account x gmail search 'from:y'")],
  [
    "resend to him",
    bash("resend emails send --to owner@example.com --from a@send.example"),
  ],
  [
    "a signed comment on his listed repo",
    bash(
      `gh issue comment 3 --repo acme/hub --body "Found it.\n${AGENT_POST_SIGNATURE}"`
    ),
  ],
  ["reading issues", bash("gh issue list --repo other/repo")],
];

test("every kind of send is refused, with a reason that names a card", () => {
  for (const [what, call] of REFUSED) {
    expect([what, sendRefusalOf(call, facts)]).toEqual([
      what,
      expect.stringContaining("Life's send guard refused this"),
    ]);
  }
});

test("reads, drafts, Life's own card and what goes to him alone are let through", () => {
  for (const [what, call] of LET_THROUGH) {
    expect([what, sendRefusalOf(call, facts)]).toEqual([what, undefined]);
  }
});

test("a refused GitHub post says what to fix", () => {
  expect(
    sendRefusalOf(bash(`gh pr comment 3 --repo acme/hub --body "x"`), facts)
  ).toContain(AGENT_POST_SIGNATURE);
});

test("the hook's own command: exit 2 with the reason for a send, 0 for a read, 2 when its facts are missing (fails closed)", async () => {
  const run = (call: ToolCall, env: Record<string, string>) =>
    exec(["sh", "-c", SEND_GUARD_HOOK.command], {
      env: {
        LIFE_BUN: process.execPath,
        LIFE_SEND_GUARD: join(import.meta.dir, "send-guard-hook.ts"),
        PATH: process.env.PATH ?? "",
        ...env,
      },
      stdin: JSON.stringify(call),
    });
  const withFacts = { LIFE_SEND_FACTS: JSON.stringify(facts) };
  const send = await run(bash("imsg send --to +15550100 hi"), withFacts);
  expect([send.code, send.stderr]).toEqual([
    2,
    expect.stringContaining("a send command"),
  ]);
  expect((await run(bash("ls"), withFacts)).code).toBe(0);
  expect((await run(bash("ls"), {})).code).toBe(2);
  expect(
    (await run(bash("ls"), { ...withFacts, LIFE_SEND_GUARD: "" })).code
  ).toBe(2);
});

test.skipIf(!(await Bun.file(CODEX).exists()))(
  "the pinned Codex gives the guard's hook a hash to trust, from an empty home",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "life-codex-"));
    const trust = await readCodexGuardTrust(CODEX, {
      CODEX_HOME: home,
      HOME: home,
    });
    expect(Object.values(trust)).toEqual([
      { trusted_hash: expect.stringMatching(SHA256) },
    ]);
  },
  30_000
);
