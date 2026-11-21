import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readProjectNow, readProjectsNow } from "../projects-read";
import { IfNot, tool } from "./mcp-tool";

/** Registers the Projects tab's reads: `read_projects` (the chip row) and `read_project` (one project's header and details). */
export function projectTools(server: McpServer) {
  tool(
    server,
    "read_projects",
    "The Projects tab's chip row (JSON): `all` (`open` running matters, `needYou` of them), then `chips` in the order to show: the underway projects (those with a matter that needs him first, then in the order of his goals), the areas that hold a running matter in no project, then the parked projects. Each chip: `kind` (project or area), `id`, `name`, for a project its `status` and `area` (id), `needYou` (its running matters that need him, as `read_matters` says), `agentAtWork` (a registered agent is running on it or on one of its matters; never for a parked project) and `matters` (how many it holds). A chip's list is `read_matters` with its `project`, or its `area` and `noProject`: the same rule gives both. `version`: pass it back as `ifNot` to get only `{version, unchanged: true}` while nothing changed. `read_project` opens one project's header.",
    z.object({ ifNot: IfNot }),
    ({ ifNot }) => readProjectsNow(ifNot)
  );
  tool(
    server,
    "read_project",
    "One project's header and details (JSON, `project`): `id`, `name`, `status` (active, waiting, parked, done), `goal` (`text`, its `rank` among his `of` goals; null when none names it), `situation` (where it stands: lines of `text` citing matter steps in `cites`; empty until made), `ask` (the most pressing open decision about one of its matters: `ref` (the card, as `read_inbox` gives it), `question`, `deadline`, `matter`; null when none), `agents` (registered agents running or waiting on it or its matters, none while it is parked or done: `id`, `title`, `status`, `line`), and its directory entry: `people` (parties), `chats` (`key`, `name`) and `repos` (`name`, and `folder`, its main worktree on the Mac; null for one only on GitHub). Its matters are `read_matters` of the project. `version`: pass it back as `ifNot`.",
    z.object({
      ifNot: IfNot,
      project: z.string().min(1).describe("Project id or name"),
    }),
    ({ ifNot, project }) => readProjectNow(project, ifNot)
  );
}
