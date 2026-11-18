import { createHmac } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { same, secretIn } from "../core/secret";
import { agentOf } from "../host/desk-read";
import { DOOR_PORT, text } from "../host/http/http";
import { READ_ONLY, tool, WRITES } from "../host/http/mcp-tool";
import { DecisionRequest } from "../memory/decisions";
import { AgentWait } from "../records/registered-agent";
import {
  askDecision,
  finish,
  readPacket,
  setWait,
  writeNotes,
} from "./agent-actions";
import type { Desk } from "./desk-store";

// The door (the desk spec, 5.2): the desk's MCP server for its registered agents, on loopback only, at `/mcp/<agt_…>`.
// An agent is known by its key alone, `HMAC(deskKey, its id)`: derived, never stored, given to its session only in the
// runtime's environment. Five tools, each one of `agent-actions.ts`; everything else an agent does with its own tools.

const BEARER = /^Bearer /;
const AGENT_PATH = /^\/mcp\/(agt_[0-9a-f]+)$/;

/** The key of agent `id`'s door. */
const keyOf = (id: string) =>
  createHmac("sha256", secretIn("deskKey")).update(id).digest("hex");

/** Where agent `id`'s session reaches its door, and the key it shows there. */
export const doorOf = (id: string) => ({
  key: keyOf(id),
  url: `http://127.0.0.1:${DOOR_PORT}/mcp/${id}`,
});

/**
 * Agent `id`'s door: its five tools, registered as the connector's are (`tool()`), each refused unless the agent is
 * active (`read_packet` aside).
 */
function doorServer(desk: Desk, id: string) {
  const server = new McpServer({ name: "desk", version: "1" });
  const door = <S extends z.ZodObject>(
    name: string,
    description: string,
    input: S,
    run: (args: z.infer<S>) => unknown
  ) =>
    tool(
      server,
      name,
      description,
      input,
      async (args) => {
        if (
          name !== "read_packet" &&
          agentOf(desk.db, id)?.status !== "active"
        ) {
          throw new Error(`Not done: ${id} is not active.`);
        }
        const r = await run(args);
        if (typeof r === "object" && r !== null && "error" in r) {
          throw new Error(String(r.error));
        }
        return (r as string | Record<string, unknown> | undefined) ?? "Done.";
      },
      name === "read_packet" ? READ_ONLY : WRITES
    );
  door(
    "set_wait",
    "Set what you wait for before you stop: `events` (messages: `person`, `channels`, `chat`, `from_me`), `until` (5 minutes to 7 days ahead, ISO), `reason`. The desk wakes you at `until`, on a matching message, or on his answer to your decision.",
    AgentWait,
    (w) => setWait(desk, id, w)
  );
  door(
    "finish",
    "End your work for good, with its `outcome` in one line; your open decision is withdrawn.",
    z.object({ outcome: z.string().min(1).max(300) }),
    ({ outcome }) => finish(desk, id, outcome)
  );
  door(
    "write_notes",
    "Replace your notes (6,000 characters): what you did, what you wait on, why. They open your next packet.",
    z.object({ text: z.string().min(1) }),
    ({ text: notes }) => writeNotes(desk, id, notes)
  );
  door(
    "request_decision",
    "Ask the owner one decision (one open at a time): `question`, 2 to 4 `options` (`id`, `label`), `recommended` (option ids), `why`, `context` (what was done, what each option leads to, the exact text and recipient of any message to approve), `deadline` (1 hour to 14 days ahead), `onSilence` (the option you take if he doesn't answer, or null), `subject`. Or `withdraw` (your decision's id) with `why`. His answer wakes you.",
    DecisionRequest,
    (ask) => askDecision(desk, id, ask)
  );
  door(
    "read_packet",
    "Your brief, your notes, the events waiting for you and your open decision.",
    z.object({}),
    () => readPacket(desk, id)
  );
  return server;
}

/**
 * The door's requests: `/mcp/<agt_…>` with that agent's key as a bearer, else 401, the same for an unknown agent and a
 * wrong key; 404 for any other path.
 */
export function doorFetch(desk: Desk) {
  return (req: Request) => {
    const id = AGENT_PATH.exec(new URL(req.url).pathname)?.[1];
    if (!id) {
      return text("not found", 404);
    }
    const given = req.headers.get("authorization")?.replace(BEARER, "") ?? "";
    if (!(agentOf(desk.db, id) && same(given, keyOf(id)))) {
      return text("unauthorized", 401);
    }
    return createMcpHandler(() => doorServer(desk, id), {}).fetch(req, {
      authInfo: {
        clientId: "door",
        extra: { agent: id },
        scopes: [],
        token: "",
      },
    });
  };
}

/** Serves the door on loopback (`DOOR_PORT`). */
export function openDoor(desk: Desk) {
  Bun.serve({
    development: false,
    fetch: doorFetch(desk),
    hostname: "127.0.0.1",
    maxRequestBodySize: 256 * 1024,
    port: DOOR_PORT,
  });
}
