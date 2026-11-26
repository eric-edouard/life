import type { McpServer } from "@modelcontextprotocol/server";
import { NetworkSignIn, signInToNetwork } from "../network-sign-in";
import { tool, WRITES } from "./mcp-tool";

// The connector's sign-in to a messaging network (`host/network-sign-in.ts`): his app's token only. Its answers are
// cookies, passwords and codes: `mcp.call` logs their names only (`argNamesOf`), and its refusals carry none of them.

export function networkSignInTool(server: McpServer, notHis: string) {
  tool(
    server,
    "sign_in_to_network",
    'His app\'s token only, on his tap of a card\'s sign-in option (`signsIn`, the network): signs that network\'s bridge in, one login step per call. `{network}` starts its sign-in, only while it is signed out or never linked. Then answer each step with its `loginId`, `stepId`, `type` and `answers` (its values by field id; none for `display_and_wait`). Returns JSON: `{status: "step", step}` (`loginId`, `stepId`, `type` (`user_input`, `cookies`, `display_and_wait`), `instructions` (Markdown), and by type `fields` (`id`, `name`, `type`, `description`), `cookies` (`url`, `userAgent`, `waitForUrlPattern`, `extractJs`, `fields`: `id`, `required`, `sources`: `type` (`cookie`, `local_storage`, `request_header`, `request_body`, `special`), `name`, `cookieDomain`, `requestUrlRegex`), `display` (`type` `qr`, `code`, `emoji` or `nothing`, and `data`)); `{status: "waiting", loginId, stepId}` (a `display_and_wait` step he has not done yet: ask again with the same step; progress pings every 10 s while held); `{status: "done", network}` (linked: its card leaves).',
    NetworkSignIn,
    (a, agent, call) => {
      if (agent) {
        throw new Error(notHis);
      }
      return signInToNetwork(a, call.report);
    },
    WRITES
  );
}
