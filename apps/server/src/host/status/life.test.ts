import { expect, test } from "bun:test";
import { join } from "node:path";
import { DAY } from "../../core/clock";
import { log } from "../../core/log";
import { systemZone } from "../../core/platform";
import { lifeStatus } from "./life";

test("the status holds the midday while the last quota reading is over the reserve; an unread one holds nothing", async () => {
  const now = new Date();
  const resetsAt = new Date(now.getTime() + DAY).toISOString();
  log("quota.read", { resetsAt, used: 80 });
  expect((await lifeStatus(now)).midday.next.why).toStartWith("held");
  log("quota.read");
  expect((await lifeStatus(now)).midday.next.why).not.toStartWith("held");
});

test("the status reads only read: no write, log, model call, action or send", async () => {
  const source = (
    await Promise.all(
      ["../../memory/changes.ts", "../../memory/run-log.ts", "life.ts"].map(
        (f) => Bun.file(join(import.meta.dir, f)).text()
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

test("the status's time zone is the Mac's read now, never the process's own (a long-running server keeps the zone it started in)", async () => {
  const was = process.env.TZ;
  // The process in another zone than the Mac's, as a server started before a move is.
  process.env.TZ =
    systemZone() === "Pacific/Kiritimati"
      ? "Africa/Lagos"
      : "Pacific/Kiritimati";
  try {
    expect((await lifeStatus(new Date())).timeZone).toBe(systemZone());
  } finally {
    if (was === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = was;
    }
  }
});
