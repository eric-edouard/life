import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readSpending } from "../spending-read";
import { tool } from "./mcp-tool";

// The connector's model spending (decision 83): `read_spending`, his token only. Metadata only: amounts, tokens,
// providers, kinds, the names of his agents and matters.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function spendingTool(server: McpServer, notHis: string) {
  tool(
    server,
    "read_spending",
    "His token only. What Life costs, for his app, not for questions about his life (JSON), in one month (`month` \"YYYY-MM\", default his current one). Two bases, never added: `billed`, dollars a provider charged (OpenRouter, allmodels, ElevenLabs; the Mac's describer, speech service and Apple's model at $0), and `equivalent`, his Claude and Codex plans' tokens at list price, not billed. An amount: `amount`, `currency` \"USD\", `basis`. `today` (his day so far) and `month`: billed; `days`: each day held (the current month: the 1st to today), its `billed`; `byProvider`: `provider`, `billed` or `equivalent`, `tokens`, `reported` (false: one of its spends came without its amount; what was reported still counts); `byKind` (`night`, `daytime`, `agents` (their models), `web_search` (their web searches), `apify` (their Apify runs), `voice`): `billed` (the agents: `equivalent`, and `billed` for those on pi when any), `tokens`; `unsettled`: Voice work not settled when its day was written, not counted (the month a floor); `topMatters` (`id`, `matter` its name; a turn's matter by its assignment's anchors): at most 5 by tokens, `tokens`, `equivalent`, `billed` (on pi, when any) and `reported`; `observedAt`. Fails when a day or the desk can't be read.",
    z.object({ month: z.string().regex(MONTH).optional() }),
    ({ month }, agent) => {
      if (agent) {
        throw new Error(notHis);
      }
      return readSpending(month);
    }
  );
}
