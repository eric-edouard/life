import { expect, test } from "bun:test";
import { log } from "../log";
import { reviewed } from "./nightly";

test("a daily review reached Life only when ChatGPT read `day` in the last 24 h", async () => {
  const now = new Date();
  log("mcp.call", { agent: "Claude-User", tool: "day" });
  log("mcp.call", { agent: "openai-mcp/1.0.0", tool: "person" });
  expect(await reviewed(now)).toBe(false);
  log("mcp.call", { agent: "openai-mcp/1.0.0", tool: "day" });
  expect(await reviewed(now)).toBe(true);
  expect(await reviewed(new Date(now.getTime() + 25 * 3_600_000))).toBe(false);
});
