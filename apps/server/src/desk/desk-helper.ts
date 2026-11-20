import { z } from "zod";
import { clock, MIN } from "../core/clock";
import { hold } from "../core/lock";
import { log } from "../core/log";
import type { RuntimeName } from "../core/names";
import { off } from "../core/outputs";
import { dayNow } from "../memory/zones";
import { tick } from "./desk-clock";
import { openDoor } from "./desk-door";
import { type Desk, openDesk, postReportLine } from "./desk-store";
import { stepStore } from "./store-step";
import { acpRuntime } from "./runtimes/acp-runtime";
import type { Runtime } from "./runtimes/contract";
import { runtimeRowsOf } from "./runtimes/runtime-rows";

// The desk's helper, `life desk`: its own process (Life.app's supervisor keeps it while `desk` is set), its own lock in
// `MACHINE_DIR`, its own store and its door; never the memory lock. Off, it returns before any of them.

/** The runtimes the desk drives, by name. */
const RUNTIMES = Object.fromEntries(
  Object.entries(runtimeRowsOf()).map(([name, row]) => [name, acpRuntime(row)])
) as Record<RuntimeName, Runtime>;
/** The clock ticks every 5 s (his answer starts a turn within 15 s); the messages are polled every 6th tick, 30 s. */
const TICK_MS = 5000;
const POLL_EVERY = 6;
/** A tick past this has hung: the helper exits, and the supervisor starts it again. */
const HUNG_AFTER = 5 * MIN;

/** What `life desk report-line` takes: who posts it (a scheduled task, a session), the line, its link, its day (today by default). */
const ReportLinePosted = z
  .object({
    day: z.iso.date().optional(),
    line: z.string().min(1).max(300),
    link: z.string().min(1).optional(),
    source: z.string().min(1).max(60),
  })
  .strict();

/**
 * `life desk`: the helper, kept running by the app; `life desk report-line '<json>'` posts a line for the nightly
 * report's Agents section (one per source per day: a second replaces it).
 */
export async function desk() {
  const why = off("desk");
  if (why) {
    console.log(why);
    return 0;
  }
  const [verb, json] = process.argv.slice(3);
  if (verb === "report-line") {
    const r = ReportLinePosted.parse(JSON.parse(json ?? ""));
    postReportLine(openDesk(), { ...r, day: r.day ?? dayNow() });
    return 0;
  }
  await hold("desk");
  // The store's shape, before anything opens it; a refusal leaves the desk off, saying why.
  log("desk.store_step", { done: stepStore() });
  const d: Desk = { db: openDesk(), runtimes: RUNTIMES };
  openDoor(d);
  let since = performance.now();
  setInterval(() => {
    if (performance.now() - since > HUNG_AFTER) {
      console.error(`${clock().toISOString()} desk: a tick passed 5 minutes`);
      process.exit(1);
    }
  }, MIN);
  for (let n = 0; ; n += 1) {
    since = performance.now();
    // biome-ignore lint/performance/noAwaitInLoops: one tick at a time, then a pause
    await tick(d, n % POLL_EVERY === 0).then(() => Bun.sleep(TICK_MS));
  }
}
