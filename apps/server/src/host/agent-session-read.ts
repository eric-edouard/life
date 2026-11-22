import { join } from "node:path";
import { clock } from "../core/clock";
import { PI_DIR } from "../core/paths";
import { agentOf, readDesk } from "./desk-read";

// An agent's session on pi as his app shows it, read-only (the owner's decision 2 of 22 Nov 2026,
// `docs/plans/pi-runtime.md`): pi's own session file under the desk's folder, its newest lines, each cut short. pi has
// no app of its own, so his app is where he reads one; an agent on Claude Code or Codex opens in its program (`link`).
// What Life sent it is `asked`, its words `said`, its tool calls `tool` and their answers `result` (`error` when the tool
// failed), and a compaction's summary `summary`; its thinking is left out.

/** The most of a session's end read, the lines shown, and the characters of one line. */
const TAIL_BYTES = 1_000_000;
const SESSION_LINES = 200;
const LINE_CHARS = 2000;

/** The session file of `ref` under `sessions`, if pi wrote one (`<time>_<ref>.jsonl`). */
export const piSessionFileOf = (sessions: string, ref: string) => {
  try {
    const name = new Bun.Glob(`*_${ref}.jsonl`).scanSync(sessions).next().value;
    return name ? join(sessions, name) : undefined;
  } catch {
    // no sessions folder yet
  }
};

export interface SessionLine {
  at: string;
  isError?: boolean;
  kind: "asked" | "result" | "said" | "summary" | "tool";
  text: string;
  /** The tool a `tool` or `result` line is of. */
  tool?: string;
}

type Part =
  | { text: string; type: "text" }
  | { arguments: unknown; name: string; type: "toolCall" }
  | { type: "image" | "thinking" };

/** One entry of pi's session file, as far as the view reads it. */
interface Entry {
  message?: {
    content: Part[] | string;
    isError?: boolean;
    role: string;
    toolName?: string;
  };
  summary?: string;
  timestamp: string;
  type: string;
}

const cut = (t: string) =>
  t.length > LINE_CHARS ? `${t.slice(0, LINE_CHARS)}…` : t;

const textOf = (content: Part[] | string) =>
  typeof content === "string"
    ? content
    : content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

/** What one entry shows: a message's parts, or a compaction's summary. */
function linesOf(e: Entry): SessionLine[] {
  const at = e.timestamp;
  if (e.type === "compaction" && e.summary) {
    return [{ at, kind: "summary", text: cut(e.summary) }];
  }
  const m = e.message;
  if (e.type !== "message" || !m) {
    return [];
  }
  if (m.role === "user") {
    return [{ at, kind: "asked", text: cut(textOf(m.content)) }];
  }
  if (m.role === "toolResult") {
    return [
      {
        at,
        isError: m.isError === true,
        kind: "result",
        text: cut(textOf(m.content)),
        tool: m.toolName,
      },
    ];
  }
  if (m.role !== "assistant" || typeof m.content === "string") {
    return [];
  }
  return m.content.flatMap((p): SessionLine[] => {
    if (p.type === "text" && p.text.trim()) {
      return [{ at, kind: "said", text: cut(p.text) }];
    }
    if (p.type === "toolCall") {
      return [
        {
          at,
          kind: "tool",
          text: cut(JSON.stringify(p.arguments)),
          tool: p.name,
        },
      ];
    }
    return [];
  });
}

/** The newest lines of the session file at `file`: its last `TAIL_BYTES` read, a line cut by that start left out. */
export async function readSessionLines(file: string) {
  const f = Bun.file(file);
  const from = Math.max(0, f.size - TAIL_BYTES);
  const text = await f.slice(from).text();
  const whole = from > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  return whole
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return linesOf(JSON.parse(l) as Entry);
      } catch {
        // a line pi is still writing
        return [];
      }
    })
    .slice(-SESSION_LINES);
}

/** Agent `id`'s current session on pi, as his app shows it; none yet is no lines. Fails for an agent on another runtime. */
export async function readAgentSession(
  id: string,
  sessions = join(PI_DIR, "sessions")
) {
  const read = readDesk((db) => agentOf(db, id), null);
  if (read.state !== "ok") {
    throw new Error(
      read.state === "off" ? "the desk is off" : `the desk: ${read.why}`
    );
  }
  const agent = read.value;
  if (!agent) {
    throw new Error(`no agent ${id}`);
  }
  if (agent.runtime !== "pi") {
    throw new Error(
      `${id} runs on ${agent.runtime}: its session opens in its program (its link)`
    );
  }
  const file = agent.session && piSessionFileOf(sessions, agent.session);
  return {
    agent: id,
    lines: file ? await readSessionLines(file) : [],
    observedAt: clock().toISOString(),
  };
}
