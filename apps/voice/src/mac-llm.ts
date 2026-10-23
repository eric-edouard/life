// What a model call's run on the Mac means: the helper sends the CLI's raw output (mac-socket.ts
// `llm.output`), and this reads it into an answer or a failure. Pure; tested in mac-llm.test.ts.

import type { MacEngine } from "@life/voice-db/schema";
import type { ModelReply } from "./providers";

// The Mac kills a call after this; the server waits a little longer for its word (mac-socket.ts).
export const MAC_KILL_MS = 170_000;

// "auth" (the CLI is signed out) and "limit" (the subscription's limit) keep that engine off the
// Mac for a while; the others fail the call alone.
export type MacFailure = "auth" | "limit" | "timeout" | "failed";

// What the helper reports of one run: the CLI's stdout and stderr, Codex's final answer file, its
// exit status, and whether it was killed at `timeoutMs`. Or, when it could not run, why.
export type MacOutput =
  | {
      final?: string | undefined;
      status: number;
      stderr: string;
      stdout: string;
      timedOut: boolean;
    }
  | { signedOut: boolean; unrun: string };

export type MacAnswer =
  | ({ ok: true } & ModelReply)
  | { detail: string; ok: false; reason: MacFailure };

const record = (value: unknown) =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
const parse = (text: string) => {
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
};
const count = (value: unknown) => (typeof value === "number" ? value : 0);

function reason(message: string, status?: unknown): MacFailure {
  const text = message.toLowerCase();
  if (
    status === 401 ||
    ["authenticat", "oauth", "/login", "api key"].some((w) => text.includes(w))
  ) {
    return "auth";
  }
  if (
    status === 429 ||
    [
      "usage limit",
      "rate limit",
      "rate_limit",
      "hit your limit",
      "limit reached",
    ].some((w) => text.includes(w))
  ) {
    return "limit";
  }
  return "failed";
}

const NEWLINE = /\r?\n/;
const KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;
// One line of at most 200 characters, with anything shaped like a key removed.
function short(message: string) {
  const line = message.trim().split(NEWLINE)[0] || "no output";
  return line.replace(KEY, "[redacted]").slice(0, 200);
}

const failure = (message: string, status?: unknown): MacAnswer => ({
  detail: short(message),
  ok: false,
  reason: reason(message, status),
});

const str = (value: unknown, otherwise: string) =>
  typeof value === "string" ? value : otherwise;
const tokens = (usage: unknown) => ({
  inputTokens: count(record(usage)?.input_tokens),
  outputTokens: count(record(usage)?.output_tokens),
});

// `claude -p --output-format json`: the structured output, else the result text.
function claude(stdout: string, stderr: string): MacAnswer {
  const output = parse(stdout) ?? {};
  const text =
    output.structured_output === undefined
      ? output.result
      : JSON.stringify(output.structured_output);
  if (output.is_error === false && typeof text === "string") {
    return { ok: true, text, ...tokens(output.usage) };
  }
  return failure(str(output.result, "") || stderr, output.api_error_status);
}

// `codex exec --json`: a completed turn and a final answer are both required. Only `turn.failed`
// fails it: an `error` event can be a retry Codex recovers from ("Reconnecting… 1/5"), and its
// message is kept only as the detail of a failure.
interface CodexRun {
  completed: boolean;
  error: string;
  failed: boolean;
  inputTokens: number;
  outputTokens: number;
  text: string;
}
type Event = Record<string, unknown>;
const CODEX_EVENTS: Record<string, (run: CodexRun, e: Event) => CodexRun> = {
  error: (run, e) => ({ ...run, error: str(e.message, run.error) }),
  "item.completed": (run, e) => {
    const item = record(e.item);
    return item?.type === "agent_message" && !run.text
      ? { ...run, text: str(item.text, "") }
      : run;
  },
  "turn.completed": (run, e) => ({
    ...run,
    completed: true,
    ...tokens(e.usage),
  }),
  "turn.failed": (run, e) => ({
    ...run,
    error: str(record(e.error)?.message, run.error),
    failed: true,
  }),
};
function codex(
  events: string,
  final: string,
  stderr: string,
  status: number
): MacAnswer {
  const start: CodexRun = {
    completed: false,
    error: "",
    failed: false,
    inputTokens: 0,
    outputTokens: 0,
    text: final.trim(),
  };
  const run = events
    .split("\n")
    .map(parse)
    .reduce(
      (sofar, event) =>
        CODEX_EVENTS[str(event?.type, "")]?.(sofar, event ?? {}) ?? sofar,
      start
    );
  const answered = run.completed && !run.failed && run.text;
  if (status === 0 && answered) {
    const { inputTokens, outputTokens, text } = run;
    return { inputTokens, ok: true, outputTokens, text };
  }
  return failure(run.error || stderr);
}

export function macAnswer(engine: MacEngine, output: MacOutput): MacAnswer {
  if ("unrun" in output) {
    return {
      detail: short(output.unrun),
      ok: false,
      reason: output.signedOut ? "auth" : "failed",
    };
  }
  if (output.timedOut) {
    return {
      detail: `${engine} ran over ${MAC_KILL_MS / 1000} s`,
      ok: false,
      reason: "timeout",
    };
  }
  return engine === "codex"
    ? codex(output.stdout, output.final ?? "", output.stderr, output.status)
    : claude(output.stdout, output.stderr);
}
