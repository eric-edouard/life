// The send guard: what an agent of his own Life may not send by itself (his word of 20 Nov 2026: "yes you can add it":
// the tools that put words in front of another person in his name, outside a card, are refused; everything else keeps
// full power). Pure: the rules over one tool call and the facts its row passes (`SendFacts`). Both runtimes run it as a
// `PreToolUse` command hook (`send-guard-hook.ts`) before every shell and MCP call; nothing goes in his own config.
// Partial on purpose (SECURITY.md): it reads a call's text, so a tab already open on a messaging site, a script that
// builds its address, `gh api` or `curl` to a service's API, or another program the agent starts get past it.

import { AGENT_POST_SIGNATURE } from "../core/names";

/** A tool call as both runtimes hand it to a `PreToolUse` hook. */
export interface ToolCall {
  tool_input?: unknown;
  tool_name: string;
}

/** What the row knows at spawn and the hook can't read itself: his own addresses and the repos an agent may post to itself. */
export interface SendFacts {
  ownAddresses: string[];
  postRepos: string[];
}

/**
 * The hook both runtimes run: a shell command, the same text everywhere (Codex trusts it by its hash), any failure a
 * refusal (exit 2). The script is checked first: `bun` given no file prints its help and exits 0.
 */
export const SEND_GUARD_HOOK = {
  command:
    '[ -f "$LIFE_SEND_GUARD" ] && BUN_BE_BUN=1 "$LIFE_BUN" "$LIFE_SEND_GUARD" || exit 2',
  matcher: "Bash|mcp__.*",
};

const MESSAGING_SITES =
  /\b(web\.whatsapp\.com|wa\.me|messenger\.com|instagram\.com\/direct|mail\.google\.com|linkedin\.com\/messaging|web\.telegram\.org|line\.me|chat\.line\.biz)/i;
const MESSAGING_APPS =
  /\b(Messages|WhatsApp|Mail|Telegram|LINE|Beeper|Signal|Messenger)\b/;
const COMPUTER_USE = /computer.?use/i;
const AGENT_DESKTOP = /\bagent-desktop\b/;
const SEND_TOOL = /(^|_)(send|reply|forward)(_|$)/i;
const EVENT_TOOL = /(^|_)(create|update)_event$/;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const SEND_COMMANDS = [
  /\bgog\b[^\n|;&]*\bgmail\b[^\n|;&]*\b(send|reply|reply-all|replyall|forward|fwd|post)\b/,
  /\bgog\b[^\n|;&]*\bcalendar\b[^\n|;&]*--attendees?\b/,
  /\bimsg\s+send\b/,
  /\bosascript\b.*application\s+\\?"(Messages|Mail)\\?".*\bsend\b/is,
];
const RESEND = /\bresend\b[^\n|;&]*\bsend\b/;
/** resend's sender options, whose address is no recipient. */
const SENDER = /--(from|reply-to)[=\s]+("[^"]*"|'[^']*'|\S+)/g;
const GH_POST = /\bgh\s+(issue\s+(comment|create)|pr\s+(comment|review))\b/;
const GH_REPO = /(?:--repo|-R)[=\s]+["']?([\w.-]+\/[\w.-]+)/g;
/** The signature ends the body: a closing quote, a line end or the command's end follows it. */
const ENDS_BODY = /^\s*(["']|\n|$)/;

/** His connector's write tools: an agent asks him through its own door, never as him. */
const CONNECTOR_WRITES = new Set([
  "answer_check",
  "request_decision",
  "change_directory_entry",
  "change_registered_agent",
  "change_todo_item",
  "correct_memory",
  "tell_life",
]);

const CARD =
  "Ask him with a card instead (`request_decision` with the message as its draft): Life sends it on his yes.";

/** A call's text: a shell call's command, else its whole input. */
const textOf = (c: ToolCall) => {
  const input = c.tool_input as { command?: unknown } | undefined;
  return c.tool_name === "Bash" && typeof input?.command === "string"
    ? input.command
    : JSON.stringify(c.tool_input ?? {});
};

/** The addresses in `text` that are not his. */
const othersIn = (text: string, own: string[]) =>
  (text.match(EMAIL) ?? []).filter(
    (a) => !own.some((o) => o.toLowerCase() === a.toLowerCase())
  );

/** Why a `gh` post is refused: a repo it names is not one he listed, or its body does not end with the signature. */
function ghRefusalOf(command: string, f: SendFacts) {
  const repos = [...command.matchAll(GH_REPO)].map((m) => m[1] ?? "");
  if (repos.length === 0) {
    return "Name the repo with --repo: posts go only to the repos he listed for agents.";
  }
  const unlisted = repos.find(
    (repo) => !f.postRepos.some((r) => r.toLowerCase() === repo.toLowerCase())
  );
  if (unlisted) {
    return `He has not listed ${unlisted} for agents' posts. ${CARD}`;
  }
  const at = command.lastIndexOf(AGENT_POST_SIGNATURE);
  return at >= 0 &&
    ENDS_BODY.test(command.slice(at + AGENT_POST_SIGNATURE.length))
    ? undefined
    : `End the body (given with --body, not a file) with this line: ${AGENT_POST_SIGNATURE}`;
}

/** Each rule: why it refuses the call, or undefined when it doesn't. */
const SEND_RULES: {
  name: string;
  why: (c: ToolCall, text: string, f: SendFacts) => string | undefined;
}[] = [
  {
    name: "a messaging site",
    why: (_c, text) =>
      MESSAGING_SITES.test(text)
        ? `Agents don't open a messaging site. ${CARD}`
        : undefined,
  },
  {
    name: "a messaging app driven",
    why: (c, text) =>
      (COMPUTER_USE.test(c.tool_name) ||
        (c.tool_name === "Bash" && AGENT_DESKTOP.test(text))) &&
      MESSAGING_APPS.test(text)
        ? `Agents don't drive a messaging app. ${CARD}`
        : undefined,
  },
  {
    name: "a connector's send",
    why: (c) => {
      const tool = c.tool_name.split("__").at(-1) ?? "";
      return c.tool_name.startsWith("mcp__") &&
        (SEND_TOOL.test(tool) || tool === "respond_to_event")
        ? `Agents don't send, reply, forward or answer invitations. A draft is fine. ${CARD}`
        : undefined;
    },
  },
  {
    name: "his connector's writes",
    why: (c) => {
      const [, server, ...rest] = c.tool_name.split("__");
      return c.tool_name.startsWith("mcp__") &&
        server !== "desk" &&
        CONNECTOR_WRITES.has(rest.at(-1) ?? "")
        ? "Agents don't write as him through his Life connector. Ask him through your desk door (`request_decision` there). If your door is missing, say so in one line and stop."
        : undefined;
    },
  },
  {
    name: "an invitation to others",
    why: (c, _text, f) =>
      EVENT_TOOL.test(c.tool_name) &&
      othersIn(
        JSON.stringify(
          (c.tool_input as { attendees?: unknown } | undefined)?.attendees ?? []
        ),
        f.ownAddresses
      ).length > 0
        ? `An event with attendees other than him invites them. ${CARD}`
        : undefined,
  },
  {
    name: "a send command",
    why: (c, text) =>
      c.tool_name === "Bash" && SEND_COMMANDS.some((r) => r.test(text))
        ? `Agents don't send messages or mail. ${CARD}`
        : undefined,
  },
  {
    name: "resend to others",
    why: (c, text, f) => {
      if (c.tool_name !== "Bash" || !RESEND.test(text)) {
        return;
      }
      const named = text.replace(SENDER, "").match(EMAIL) ?? [];
      return named.length > 0 &&
        othersIn(named.join(" "), f.ownAddresses).length === 0
        ? undefined
        : `resend goes only to his own addresses (${f.ownAddresses.join(", ") || "none known"}), named with --to. ${CARD}`;
    },
  },
  {
    name: "a GitHub post",
    why: (c, text, f) =>
      c.tool_name === "Bash" && GH_POST.test(text)
        ? ghRefusalOf(text, f)
        : undefined,
  },
];

/** Why the call is refused (the first rule that refuses it), or undefined when it may run. Pure. */
export function sendRefusalOf(c: ToolCall, f: SendFacts) {
  const text = textOf(c);
  for (const rule of SEND_RULES) {
    const why = rule.why(c, text, f);
    if (why) {
      return `Life's send guard refused this (${rule.name}): ${why}`;
    }
  }
}
