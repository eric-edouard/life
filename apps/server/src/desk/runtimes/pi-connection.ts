import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../../core/log";
import type { Agent, CallUsage, RunEnd, Update, Usage } from "./contract";
import { PI_EXTENSION_COMMAND, TOOL_SCHEMAS } from "./pi-extension";
import { SPENDING_TOOLS, type SpentDetails } from "./pi-subagent";
import type { providerPause } from "./provider-pause";
import {
  type Connection,
  type Open,
  type SessionRow,
  spawnFor,
} from "./session-runtime";

// pi's RPC connection (`Open`, `session-runtime.ts`): one pi process in its RPC mode (JSONL on stdio, `rpc.md`) on one
// session, spawned by its row (`pi-runtime.ts`), with what each line it prints does to the run in progress
// (`runHeard`): the turn's beginning, its usage, what its model says and does, a tool that
// keeps failing, and its end; its compaction at a turn's end, and the measures it logs.

/** pi's row: what `sessionRuntime` reads, and the command and environment of a run. */
export interface PiRow extends SessionRow {
  spawn: (
    a: Agent,
    ref: string,
    isNew: boolean,
    isAsk?: boolean
  ) => Promise<{
    /** The context past which a turn that ended well compacts its session (`compactAtOf`). */
    compactAt: number;
    command: string[];
    env: Record<string, string>;
    /** The file of what is in force on every request (`Connection.inForce`), which the extension reads. */
    inForceFile: string;
  }>;
}

/** What pi prints on stdout, as far as the runtime reads it. */
export interface PiLine {
  aborted?: boolean;
  /** A tool call's arguments (`tool_execution_start`). */
  args?: unknown;
  assistantMessageEvent?: { delta?: string; type: string };
  command?: string;
  data?: { commands?: { name: string }[]; disposition?: string };
  /** How long a tool ran (`tool_execution_end`). */
  durationMs?: number;
  /** A custom entry the extension appended (`entry_appended`): the tool schemas' size. */
  entry?: { customType?: string; data?: { chars?: number; tools?: number } };
  error?: string;
  id?: string;
  isError?: boolean;
  message?: {
    errorMessage?: string;
    role: string;
    stopReason?: string;
    usage?: CallUsage;
  };
  /** A tool's result: a spending tool's carries its usage (`SPENDING_TOOLS`); a compaction's, its summary call's (`compaction_end`). */
  result?: {
    content?: { text?: string }[];
    details?: SpentDetails;
    usage?: CallUsage;
  };
  success?: boolean;
  toolCallId?: string;
  toolName?: string;
  type: string;
}

/** The run in progress on a connection: what it heard so far, and how to settle it. */
export interface Current {
  begun: () => void;
  end: (e: RunEnd) => void;
  /** Failed calls by tool: at `FAILED_CALLS_STOP` of one, the turn stops (`stopWhy`). */
  failed?: Map<string, number>;
  /** It ended past its compaction point (`compactAtOf`): its session is compacting before it ends. */
  isCompacting?: boolean;
  /** The runtime has aborted it (`stopWhy`). */
  isStopping?: boolean;
  onUpdate?: (u: Update) => void;
  stop?: string;
  /** Why the runtime stops the turn itself (a tool that keeps failing): it aborts, and the run ends failed with this. */
  stopWhy?: string;
  usage: Usage;
  why?: string;
}

/** A turn stops once one tool has failed this many times in it (the v4 plan, bundle C, after Nod's `toolProgress`). */
const FAILED_CALLS_STOP = 5;

/** What a pi line tells the run's listener, if anything. */
function updateOf(l: PiLine): Update | undefined {
  const e = l.assistantMessageEvent?.type ?? "";
  if (l.type === "message_update" && e === "text_delta") {
    return { kind: "words", text: l.assistantMessageEvent?.delta ?? "" };
  }
  if (l.type === "message_update" && e.startsWith("thinking")) {
    return { kind: "thinking" };
  }
  if (l.type === "tool_execution_start" || l.type === "tool_execution_end") {
    const state = l.isError ? "failed" : "completed";
    return {
      ...(l.type === "tool_execution_start" ? { args: l.args } : {}),
      id: l.toolCallId ?? "",
      kind: "working",
      state: l.type === "tool_execution_start" ? "in_progress" : state,
      title: l.toolName ?? "",
    };
  }
}

/**
 * Adds one model call's usage to the run's: its tokens, its whole context as the first and last call saw it, and what
 * OpenRouter billed for it (pi reads the response's cost: `totalFromProvider`), null once a call came without it.
 */
function addUsage(u: Usage, m: CallUsage | undefined) {
  if (!m) {
    return;
  }
  addSpent(u, m);
  u.contextFirst ??= m.totalTokens;
  u.contextLast = m.totalTokens;
}

/** Adds one model call's tokens and billed dollars to the run's, never its context: a subagent's calls are not the session's. */
function addSpent(u: Usage, m: CallUsage) {
  u.billedUsd =
    m.cost?.totalFromProvider && typeof u.billedUsd === "number"
      ? u.billedUsd + m.cost.total
      : null;
  u.tokensIn += m.input + m.cacheWrite;
  u.tokensCached += m.cacheRead;
  u.tokensOut += m.output;
}

/** A line pi printed, read as JSON; none when it is not. */
const parseLine = (text: string): PiLine | undefined => {
  try {
    return JSON.parse(text) as PiLine;
  } catch {
    // not a line of pi's protocol
    return undefined;
  }
};

/** The calls line `l` bills beside the turn's own: a spending tool's, and every compaction's summary (pi's own inside the turn, the runtime's at its end). */
function spentOf(l: PiLine): CallUsage[] {
  if (l.type === "compaction_end" && l.result?.usage) {
    return [l.result.usage];
  }
  return isSpendingToolEnd(l) ? (l.result?.details?.usage ?? []) : [];
}

/** Whether `l` is a spending tool's result (`SPENDING_TOOLS`): its model calls and its searches' prices are the turn's. */
const isSpendingToolEnd = (l: PiLine) =>
  l.type === "tool_execution_end" && SPENDING_TOOLS.includes(l.toolName ?? "");

/** A failed tool call: at `FAILED_CALLS_STOP` of one tool, the turn is to stop (`stopWhy`). */
function failedHeard(c: Current, tool: string) {
  c.failed ??= new Map();
  const n = (c.failed.get(tool) ?? 0) + 1;
  c.failed.set(tool, n);
  if (n >= FAILED_CALLS_STOP) {
    c.stopWhy ??= `${tool} failed ${n} times`;
  }
}

/** What line `l` bills the run: a spending tool's or a compaction's calls, a search's price. */
function spendHeard(u: Usage, l: PiLine) {
  for (const m of spentOf(l)) {
    addSpent(u, m);
  }
  for (const usd of isSpendingToolEnd(l)
    ? (l.result?.details?.searchUsd ?? [])
    : []) {
    u.searchUsd =
      typeof usd === "number" && typeof u.searchUsd === "number"
        ? u.searchUsd + usd
        : null;
  }
}

/** What line `l` does to the run `c`: its beginning, its usage and stop, its listener's update; its end at `agent_settled`. */
export function runHeard(c: Current, l: PiLine): RunEnd | undefined {
  if (l.type === "message_update") {
    c.begun();
  }
  if (l.type === "tool_execution_end" && l.isError) {
    failedHeard(c, l.toolName ?? "");
  }
  if (l.type === "message_end" && l.message?.role === "assistant") {
    addUsage(c.usage, l.message.usage);
    c.stop = l.message.stopReason;
    c.why = l.message.errorMessage;
  }
  spendHeard(c.usage, l);
  const heard = updateOf(l);
  if (heard) {
    c.onUpdate?.(heard);
  }
  if (l.type !== "agent_settled") {
    return;
  }
  if (l.aborted) {
    return { ok: false, why: c.stopWhy ?? "cancelled" };
  }
  return c.stop === "error" || c.stop === "aborted"
    ? { ok: false, why: c.why ?? c.stop }
    : { ok: true, usage: c.usage };
}

/** Logs what a line measures (`desk.runtime`), nothing waiting on it: a tool call's time and size, the tool schemas' size. */
function logMeasures(a: Agent, l: PiLine) {
  if (l.type === "tool_execution_end") {
    log("desk.runtime", {
      agent: a.id,
      chars: (l.result?.content ?? []).reduce(
        (n, c) => n + (c.text?.length ?? 0),
        0
      ),
      ms: l.durationMs,
      ok: !l.isError,
      tool: l.toolName,
      what: "tool",
    });
  }
  if (l.type === "entry_appended" && l.entry?.customType === TOOL_SCHEMAS) {
    log("desk.runtime", {
      agent: a.id,
      ...l.entry.data,
      ok: true,
      what: "tool_schemas",
    });
  }
}

/** Why pi's answer to a prompt means no run comes; none when it started one. */
function promptRefusalOf(r: PiLine) {
  if (r.success === false) {
    return r.error ?? "pi refused the prompt";
  }
  // A prompt pi handled itself (an extension's command) starts no run: no `agent_settled` comes.
  if (r.data?.disposition === "handled") {
    return "pi handled the prompt as a command";
  }
}

/** Each line of `out` to `hear`, split on line feeds only (pi's rpc.md): a reader by lines would also split a JSON string at U+2028 or U+2029. */
function onLines(out: NodeJS.ReadableStream, hear: (line: string) => void) {
  let rest = "";
  out.setEncoding("utf8").on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      hear(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  });
}

/** A pi line's question and its answer (`ask`, by id). */
type Ask = (line: { message?: string; type: string }) => Promise<PiLine>;

/** Answers once Life's extension answers (`PI_EXTENSION_COMMAND` in `get_commands`); throws past `within`, or when pi exits first. */
async function extensionLoaded(
  ask: Ask,
  exited: Promise<void>,
  within: number
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listed = await Promise.race([
      ask({ type: "get_commands" }),
      exited.then(() => {
        throw new Error("pi exited as it started");
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`pi did not answer within ${within / 1000} s`)),
          within
        );
      }),
    ]);
    if (!listed.data?.commands?.some((c) => c.name === PI_EXTENSION_COMMAND)) {
      throw new Error(
        "Life's pi extension did not load: no agent runs unguarded"
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What event `l` does: its measures logged; on the run `c` in progress, `runHeard`, an abort once a tool keeps failing
 * (`stopWhy`), and its end told to the provider's pause (a good run lifts it, a background turn's provider error grows
 * it, any other end says nothing). The run's end, if `l` ends it.
 */
function eventHeard(
  a: Agent,
  l: PiLine,
  c: Current | undefined,
  pause: ReturnType<typeof providerPause>,
  abort: () => void,
  isAsk: boolean | undefined
) {
  logMeasures(a, l);
  const ended = c && runHeard(c, l);
  if (c?.stopWhy && !c.isStopping) {
    c.isStopping = true;
    abort();
  }
  // His own ask's failure never arms the pause; its success, like any, lifts it.
  if (c && ended && (ended.ok || (c.stop === "error" && !isAsk))) {
    pause.heard(!ended.ok);
  }
  return ended;
}

/**
 * Spawns pi in `a.folder` on session `resume` (none: a new one, its id made here) and waits for Life's extension to
 * answer (`PI_EXTENSION_COMMAND` in `get_commands`): within `launchWithin`, else pi is killed and the open fails.
 */
export const piOpenOf =
  (
    row: PiRow,
    launchWithin: number,
    pause: ReturnType<typeof providerPause>
  ): Open =>
  async (a, resume, opening, isAsk) => {
    const ref = resume ?? crypto.randomUUID();
    const { command, compactAt, env, inForceFile } = await row.spawn(
      a,
      ref,
      !resume,
      isAsk
    );
    const { child, close, exited, stopping } = spawnFor(
      a,
      command,
      env,
      opening
    );
    const answers = new Map<string, (l: PiLine) => void>();
    let current: Current | undefined;
    let asked = 0;
    const send = (line: object) =>
      child.stdin.write(`${JSON.stringify(line)}\n`);
    const ask: Ask = (line) =>
      new Promise<PiLine>((answer) => {
        asked += 1;
        const id = `life-${asked}`;
        answers.set(id, answer);
        send({ ...line, id });
      });
    const settle = (e: RunEnd) => {
      const c = current;
      current = undefined;
      // Logged by its stop reason only, a code word: pi's error message can echo the call.
      if (c && !e.ok) {
        log("desk.runtime", {
          agent: a.id,
          error: c.stop ?? "ended",
          ok: false,
          what: "turn",
        });
      }
      c?.end(e);
    };
    /** One line pi printed: a response to what the runtime asked, else an event of the run. */
    const hear = (text: string) => {
      const l = parseLine(text);
      if (l?.type === "response") {
        answers.get(l.id ?? "")?.(l);
        answers.delete(l.id ?? "");
        return;
      }
      const c = current;
      const ended =
        l && eventHeard(a, l, c, pause, () => send({ type: "abort" }), isAsk);
      if (!(c && ended)) {
        return;
      }
      if (
        c.isCompacting ||
        !(ended.ok && (c.usage.contextLast ?? 0) > compactAt)
      ) {
        settle(ended);
        return;
      }
      // The turn ends once its session is compacted (its summary billed by `compaction_end`); pi exiting first fails it.
      c.isCompacting = true;
      compactedAfter().then(() => settle(ended));
    };
    /** Compacts the session after a turn; one that fails leaves the session whole. */
    const compactedAfter = async () => {
      const r = await Promise.race([
        ask({ type: "compact" }),
        exited.then(() => undefined),
      ]);
      log("desk.runtime", {
        agent: a.id,
        ok: r?.success === true,
        what: "compact",
      });
    };
    onLines(child.stdout, hear);
    exited.then(() => settle({ ok: false, why: "pi exited" }));
    try {
      await extensionLoaded(ask, exited, launchWithin);
    } catch (error) {
      child.kill("SIGKILL");
      await close();
      throw error;
    }

    let ended: Promise<RunEnd> | undefined;
    let isPrompted = false;
    const prompt: Connection["prompt"] = (message, onUpdate) => {
      let begun: () => void = () => undefined;
      let notBegun: (e: Error) => void = () => undefined;
      const began = new Promise<void>((ok, fail) => {
        begun = ok;
        notBegun = fail;
      });
      began.catch(() => undefined);
      isPrompted = true;
      ended = new Promise<RunEnd>((end) => {
        current = {
          begun,
          end: (e) => {
            notBegun(new Error(e.why ?? "it ended before the turn began"));
            end(e);
          },
          onUpdate,
          usage: {
            billedUsd: 0,
            contextFirst: null,
            contextLast: null,
            searchUsd: 0,
            tokensCached: 0,
            tokensIn: 0,
            tokensOut: 0,
          },
        };
      });
      ask({ message, type: "prompt" }).then((r) => {
        const why = promptRefusalOf(r);
        if (why) {
          settle({ ok: false, why });
        }
      });
      return { begun: began, ended };
    };
    const stop = async () => {
      if (!isPrompted) {
        return;
      }
      send({ type: "abort" });
      await stopping(ended);
    };
    const inForce = (text: string) => {
      mkdirSync(dirname(inForceFile), { recursive: true });
      writeFileSync(inForceFile, text, { mode: 0o600 });
    };
    return { close, exited, inForce, prompt, ref, stop };
  };
