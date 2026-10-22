import { expect, test } from "bun:test";
import { join } from "node:path";
import { log } from "../../core/log";
import { lifeStatus } from "./life";

test("the status holds the midday while the last quota reading is over the reserve; an unread one holds nothing", async () => {
  const now = new Date();
  const resetsAt = new Date(now.getTime() + 86_400_000).toISOString();
  log("quota.read", { resetsAt, used: 80 });
  expect((await lifeStatus(now)).midday.next.why).toStartWith("held");
  log("quota.read");
  expect((await lifeStatus(now)).midday.next.why).not.toStartWith("held");
});

test("the dashboard only reads: no write, log, model call, action or send", async () => {
  const source = (
    await Promise.all(
      ["../../memory/feed.ts", "../../memory/history.ts", "life.ts"].map((f) =>
        Bun.file(join(import.meta.dir, f)).text()
      )
    )
  ).join("\n");
  for (const banned of [
    "Bun.write",
    "appendFile",
    "writeFile",
    "log(",
    "askOnce",
    "actAsked",
    "sendReport",
    "Bun.spawn",
    "locked(",
  ]) {
    expect(source).not.toContain(banned);
  }
  // git only reads: log and show.
  for (const m of source.matchAll(/git\(\w+, \[\s*"([a-z-]+)"/g)) {
    expect(["log", "show"]).toContain(m[1] as string);
  }
});
