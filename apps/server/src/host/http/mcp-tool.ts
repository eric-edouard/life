import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "../../core/log";
import { IDS, refusalClassOf } from "../../core/log-line";
import { clip } from "../../memory/units";

// How an MCP tool of Life's is registered: its arguments checked, its answer as text, every call logged (`mcp.call`).
// The connector (`mcp.ts`) and the desk's door (`desk/desk-door.ts`) both register theirs through `tool()`.

export const READ_ONLY = {
  destructiveHint: false,
  openWorldHint: false,
  readOnlyHint: true,
};
// `correct_memory`, `change_directory_entry` and `change_todo_item` stay on the `life:read` token: one owner, checked by `sub`. `correct_memory` is destructive (a merge
// of two people is hard to undo), so clients ask first.
export const WRITES = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};

/**
 * `change_todo_item` writes, but only his own Reminders (a remove goes to Recently Deleted) and Life's ledger, and
 * nothing it does is lost or hard to undo: not destructive, so an agent uses it unattended.
 */
export const REVERSIBLE = { ...WRITES, destructiveHint: false };

/** What an agent's token may not write: his own words (`tell_life`), his answer to a check, his Remove of an appointment. */
export const NOT_HIS =
  "Not done: this app was paired as an agent, and an agent's words are not his.";

/** What a call carries beside its arguments: `report` sends one step of an action as it passes (a `notifications/progress` message; nothing without a progress token) and `answerKey` is the app's key for one tap (`_meta` `life/answerKey`). */
export interface ToolCall {
  answerKey?: string;
  report: (step: Record<string, unknown>) => void;
}

/** A tool's work: its arguments, the caller's agent (its grant's agent claim), none for a plain app, and its call. */
export type Tool<S extends z.ZodObject> = (
  args: z.infer<S>,
  agent: string | undefined,
  call: ToolCall
) => Promise<string | Record<string, unknown> | null>;

const respond = (body: string, isError: boolean) => ({
  content: [{ text: body, type: "text" as const }],
  isError,
});

/** The answer as text, JSON sent once as text (null: the question named nothing to look for); a throw is an error to the client. */
async function answer(run: () => ReturnType<Tool<z.ZodObject>>) {
  try {
    const a = await run();
    return a !== null && typeof a === "object"
      ? respond(JSON.stringify(a), false)
      : respond(a ?? "Give more to look for.", a === null);
  } catch (e) {
    return respond((e as Error).message, true);
  }
}

/** A call's arguments as its `mcp.call` line keeps them: their names, never their values (his words can be in them). */
export const argNamesOf = (args: unknown) =>
  args && typeof args === "object" ? Object.keys(args) : [];

/**
 * The arguments with every string clipped to 200 chars: kept only by the question cases' isolated server (`READERS`),
 * whose log is a temporary folder its bench reads back (`openedOf`, scripts/question-cases.ts) and then deletes.
 */
const cut = (args: unknown) =>
  JSON.parse(
    JSON.stringify(args, (_, v) => (typeof v === "string" ? clip(v, 200) : v))
  );

/** Who asked, on every `mcp.call` line: the OAuth client and its grant's agent claim. */
export const callerOf = (auth?: AuthInfo) => ({
  agent: agentIn(auth),
  client: auth?.clientId,
});
export const agentIn = (auth?: AuthInfo) =>
  typeof auth?.extra?.agent === "string" ? auth.extra.agent : undefined;
/** The schema clients see, but every call reaches `tool()`, which validates it: invalid arguments are logged like any call. */
const unchecked = (s: z.ZodObject) => ({
  "~standard": { ...s["~standard"], validate: (value: unknown) => ({ value }) },
});

/** The servers built to serve reads only (`buildServer(true)`): a tool that is not `READ_ONLY` is never theirs. */
export const READERS = new WeakSet<McpServer>();

/** Registers one tool. Each call logs who asked (OAuth client, agent claim), its arguments' names, and what surfaced without its text: length, cited ids, error and, for an error, its class (`refused`), and the steps it reported with their ms. */
export function tool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  run: Tool<S>,
  annotations = READ_ONLY
) {
  if (READERS.has(server) && annotations !== READ_ONLY) {
    return;
  }
  server.registerTool(
    name,
    {
      annotations,
      description,
      inputSchema: unchecked(inputSchema) as unknown as z.ZodObject,
    },
    async (args, ctx) => {
      const started = performance.now();
      const { progressToken, "life/answerKey": key } = ctx.mcpReq._meta ?? {};
      // The steps go in order, and all before the result.
      let sent = Promise.resolve();
      let progress = 0;
      // Every step reported, with its ms from the call's start: where a slow action spent its time; a run of one step (a
      // streamed answer's `words`) is one entry with its `count`.
      const steps: { count?: number; ms: number; step: unknown }[] = [];
      const call: ToolCall = {
        ...(typeof key === "string" ? { answerKey: key } : {}),
        report: (step) => {
          const name = step.step ?? "plan";
          const last = steps.at(-1);
          if (last?.step === name) {
            last.count = (last.count ?? 1) + 1;
          } else {
            steps.push({
              ms: Math.round(performance.now() - started),
              step: name,
            });
          }
          if (progressToken !== undefined) {
            progress += 1;
            const params = {
              message: JSON.stringify(step),
              progress,
              progressToken,
            };
            // A closed stream never fails the action.
            sent = sent
              .then(() =>
                ctx.mcpReq.notify({ method: "notifications/progress", params })
              )
              .catch(() => undefined);
          }
        },
      };
      const parsed = inputSchema.safeParse(args);
      const result = await answer(() => {
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments: ${z.prettifyError(parsed.error)}`
          );
        }
        return run(
          parsed.data as z.infer<S>,
          agentIn(ctx.http?.authInfo),
          call
        );
      });
      await sent;
      const body = result.content.map((c) => c.text).join("");
      log("mcp.call", {
        ...callerOf(ctx.http?.authInfo),
        args: READERS.has(server) ? cut(args) : argNamesOf(args),
        chars: body.length,
        error: result.isError,
        ids: [...new Set(body.match(IDS))],
        ms: Math.round(performance.now() - started),
        ...(result.isError ? { refused: refusalClassOf(body) } : {}),
        ...(steps.length ? { steps } : {}),
        tool: name,
      });
      return result;
    }
  );
}

/** A versioned read's `ifNot`: the `version` of the caller's last answer. */
export const IfNot = z
  .string()
  .optional()
  .describe(
    "The `version` of your last answer: when nothing changed since, only `{version, unchanged: true}`"
  );
