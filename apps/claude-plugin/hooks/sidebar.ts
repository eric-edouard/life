// Files Life's agent sessions in his Claude app's sidebar: every session titled "Agent: …" (the desk's titles,
// `turn-ends.ts`) goes into the "Life Agents" section, made when it is missing (his ask of 26 Nov 2026). Only the
// Claude app serves the sidebar's tools (`ccd_sidebar`, `ccd_session_mgmt`); anywhere else the first call fails and
// nothing happens. The app's tools give no way to order sections, so a new one sits where the app puts it.

/** The sidebar section his agents sit in: the server's `AGENTS_GROUP` (`host/claude-app-listing.ts`), which reads it. */
export const AGENTS_SECTION = "Life Agents";
const AGENT_TITLE = "Agent: ";

/** `$.mcp.call` as the module gets it: a tool's result as MCP returns it. */
export type McpCall = (
  server: string,
  tool: string,
  args?: Record<string, unknown>
) => Promise<{ content?: readonly unknown[]; isError?: boolean }>;

interface Section {
  id: string;
  kind: string;
  name: string;
}
interface Session {
  group?: { id: string } | null;
  sessionId: string;
  title: string;
}

/** A tool's answer, the JSON in its first text block; a refusal throws. */
async function jsonOf<T>(
  call: McpCall,
  server: string,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const r = await call(server, tool, args);
  const text = (r.content?.[0] as { text?: string } | undefined)?.text;
  if (r.isError || text === undefined) {
    throw new Error(`${server} ${tool}: ${text ?? "no answer"}`);
  }
  return JSON.parse(text) as T;
}

const sectionIdOf = (sections: Section[]) =>
  sections.find((s) => s.kind === "manual" && s.name === AGENTS_SECTION)?.id;

/** Moves every agent session not yet in the Life Agents section into it, making the section first if missing. */
export async function fileAgentSessions(call: McpCall) {
  const listSections = () =>
    jsonOf<Section[]>(call, "ccd_sidebar", "list_sections");
  let id = sectionIdOf(await listSections());
  const [others, self] = await Promise.all([
    jsonOf<Session[]>(call, "ccd_session_mgmt", "list_sessions", {
      limit: 100,
    }),
    jsonOf<Session>(call, "ccd_session_mgmt", "get_session", {
      session_id: "self",
    }),
  ]);
  const ids = [...others, { ...self, sessionId: "self" }]
    .filter(
      (s) => s.title?.startsWith(AGENT_TITLE) && (!id || s.group?.id !== id)
    )
    .map((s) => s.sessionId);
  if (ids.length === 0) {
    return;
  }
  if (!id) {
    // ponytail: sessions starting at once may each make the section; the first one listed wins, a lock if it shows up.
    await call("ccd_sidebar", "create_section", { name: AGENTS_SECTION });
    id = sectionIdOf(await listSections());
    if (!id) {
      return;
    }
  }
  await call("ccd_sidebar", "move_sessions", {
    section_id: id,
    session_ids: ids,
  });
}
