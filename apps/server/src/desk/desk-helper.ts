import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { clock, MIN } from "../core/clock";
import { hold } from "../core/lock";
import { off } from "../core/outputs";
import { register } from "./agent-actions";
import { tick } from "./desk-clock";
import { openDoor } from "./desk-door";
import { type Desk, openDesk } from "./desk-store";
import { claudeRuntime } from "./runtimes/claude-runtime";
import type { Runtime } from "./runtimes/contract";

// The desk's helper, `life desk`: its own process (Life.app's supervisor keeps it while `desk` is set), its own lock in
// `MACHINE_DIR`, its own store and its door; never the memory lock. Off, it returns before any of them.

/** The runtimes the desk drives, by name. */
const RUNTIMES: Record<string, Runtime> = { claude: claudeRuntime };
/** The clock ticks every 5 s (his answer starts a turn within 15 s); the messages are polled every 6th tick, 30 s. */
const TICK_MS = 5000;
const POLL_EVERY = 6;
/** A tick past this has hung: the helper exits, and the supervisor starts it again. */
const HUNG_AFTER = 5 * MIN;

/** What `life desk register` takes: his words as the brief, the folder its sessions start in, its runtime. */
const Registration = z
  .object({
    brief: z.string().min(1),
    folder: z.string().refine((f) => isAbsolute(f) && existsSync(f), {
      message: "an absolute folder that exists",
    }),
    runtime: z.enum(Object.keys(RUNTIMES) as [string, ...string[]]),
  })
  .strict();

/**
 * `life desk`: the helper, kept running by the app; `life desk register '<json>'` registers an agent (its first turn
 * starts within a tick). ponytail: register is the developer's door until step 4's `change_registered_agent`.
 */
export async function desk() {
  const why = off("desk");
  if (why) {
    console.log(why);
    return 0;
  }
  const [verb, json] = process.argv.slice(3);
  if (verb === "register") {
    const r = Registration.parse(JSON.parse(json ?? ""));
    console.log(register({ db: openDesk(), runtimes: RUNTIMES }, r));
    return 0;
  }
  await hold("desk");
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
