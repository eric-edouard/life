import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readSpending } from "../spending-read";
import { tool } from "./mcp-tool";

// The connector's model spending (decision 83): `read_spending`, his token only. Metadata only: amounts, tokens,
// providers, kinds, the names of his agents and matters.

const MONTH = /^\d{4}-\d{2}$/;

export function spendingTool(server: McpServer, notHis: string) {
  tool(
    server,
    "read_spending",
    'His token only. What Life costs, for his app, not for questions about his life (JSON), in one month (`month` "YYYY-MM", default his current one). Two bases, never added: `billed`, dollars a provider charged (OpenRouter, allmodels, ElevenLabs; the Mac\'s describer, speech service and Apple\'s model at $0), and `equivalent`, his Claude and Codex plans\' tokens at list price, not billed. An amount: `amount`, `currency` "USD", `basis`. `today` (his day so far) and `month`: billed; `days`: each day held (the current month: the 1st to today), its `billed`; `byProvider`: `provider`, `billed` or `equivalent`, `tokens`, `reported` (false: one of its spends came without its amount; what was reported still counts); `byKind` (`night`, `daytime`, `agents`, `voice`): `billed`, `tokens`; `topAgents` (`agent`, its name) and `topMatters` (`matter`, its name): at most 5 each by tokens, `tokens` and `equivalent`; `observedAt`.',
    z.object({ month: z.string().regex(MONTH).optional() }),
    ({ month }, agent) => {
      if (agent) {
        throw new Error(notHis);
      }
      return readSpending(month);
    }
  );
}
