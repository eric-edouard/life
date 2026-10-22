import { expect, test } from "bun:test";
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
