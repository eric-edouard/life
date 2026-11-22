// What the Life plugin asks the desk, as plain functions over a fetch passed in (the module's `$.http.fetch`, or a test's
// handler). The desk decides everything: which session is an agent's, what its door does, what the send guard refuses.
// Nothing here holds a rule of Life's but which turns are his.

/** A fetch as the module's `$.http.fetch` answers: the status and the body read as text. */
export type Fetch = (
  url: string,
  init?: { body?: string; headers?: Record<string, string>; method?: string }
) => Promise<{ status: number; text: string }>;

/** His own Life's door on loopback: `DOOR_PORT` (`apps/server/src/host/http/http.ts`), `OWN_PORT` + 2. */
export const DOOR = "http://127.0.0.1:46202";

/** An agent's door, as the desk gives it for one of its sessions (`matcher`: the tools its send guard reads): never shown to the model. */
export interface Door {
  agent: string;
  key: string;
  matcher: string;
  url: string;
}

/** One of the door's tools, as its `tools/list` gives it. */
export interface DoorTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
}

/** Whether a prompt is one he sent himself: typed in the app (`composer`) or on his phone through Remote Control (`bridge`). */
export const isHisTurn = (kind: string) =>
  kind === "composer" || kind === "bridge";

/** Whether a call goes through the send guard: the tools the desk's matcher names (`SEND_GUARD_HOOK.matcher`). */
export const isGuarded = (matcher: string, tool: string) =>
  new RegExp(`^(?:${matcher})$`).test(tool);

/** The door of the agent whose session `session` is, or null when it is no agent's. Throws when the desk can't be asked. */
export async function lookUpSession(fetch: Fetch, session: string) {
  const r = await fetch(`${DOOR}/session/${encodeURIComponent(session)}`);
  if (r.status === 404) {
    return null;
  }
  if (r.status !== 200) {
    throw new Error(`the desk answered ${r.status}`);
  }
  return JSON.parse(r.text) as Door;
}

/** One JSON-RPC call to the door (stateless MCP over HTTP): its result. Throws on any failure. */
async function rpc(
  fetch: Fetch,
  door: Pick<Door, "key" | "url">,
  method: string,
  params: object
) {
  const r = await fetch(door.url, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${door.key}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  // The answer comes as one event (`data: {...}`) or as plain JSON.
  const data = r.text.split("\n").find((l) => l.startsWith("data:"));
  const body = JSON.parse(data ? data.slice(5) : r.text) as {
    error?: { message: string };
    result?: unknown;
  };
  if (r.status !== 200 || body.error) {
    throw new Error(body.error?.message ?? `the door answered ${r.status}`);
  }
  return body.result;
}

/** The door's tools, as the desk lists them. */
export const doorTools = async (fetch: Fetch, door: Door) =>
  ((await rpc(fetch, door, "tools/list", {})) as { tools: DoorTool[] }).tools;

/** Calls door tool `name`: its text, and whether the door refused it. */
export async function callDoor(
  fetch: Fetch,
  door: Pick<Door, "key" | "url">,
  name: string,
  args: object
) {
  const r = (await rpc(fetch, door, "tools/call", {
    arguments: args,
    name,
  })) as { content: { text?: string }[]; isError?: boolean };
  return {
    isError: r.isError === true,
    text: r.content.map((c) => c.text ?? "").join("\n"),
  };
}

/** Why the desk's send guard refuses tool call `tool` with `input`, or null when it may run; any failure refuses it. */
export async function guardRefusalOf(
  fetch: Fetch,
  door: Door,
  tool: string,
  input: object
) {
  try {
    const r = await fetch(`${DOOR}/guard/${door.agent}`, {
      body: JSON.stringify({ tool_input: input, tool_name: tool }),
      headers: {
        authorization: `Bearer ${door.key}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    if (r.status !== 200) {
      throw new Error(`the desk answered ${r.status}`);
    }
    return (JSON.parse(r.text) as { refusal: string | null }).refusal;
  } catch (e) {
    return `Life's send guard failed, so this call is refused: ${e}`;
  }
}
