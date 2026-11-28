import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { integrationsNow } from "../integrations";
import { tool } from "./mcp-tool";

// The connector's integrations (`host/integrations.ts`): `read_integrations`, his token only, for his app's setup and
// onboarding. The same read the status window's source cards and `bun life bridge` use; nothing stored.

export function integrationsTool(server: McpServer, notHis: string) {
  tool(
    server,
    "read_integrations",
    "His token only. What he can turn on and where each stands, for his app's setup and onboarding (JSON array): `id` (`ai`, `voice`, `pendant`, `source:<name>`, `network:<name>`), `group` (`ai`, `voice`, `sources`, `messaging`, `phone`), `name`, `icon` (an asset name both apps ship), `value` (`ask` and `answer`: one example), `privacy` (what leaves the computer, to whom, how to turn it off), `requirements` in the order he meets them, each with `done` (`permission` `check`; `sign_in` `with`; `key` `name`, `opens` the page where it is made; `credits` `with`; `install` `what`; `device` `what`), `state` (`off`, `waiting_on_user`, `connecting`, `working`, `broken`) and `why` (plain words, for waiting_on_user and broken).",
    z.object({}),
    (_, agent) => {
      if (agent) {
        throw new Error(notHis);
      }
      return integrationsNow();
    }
  );
}
