import { clock, MIN } from "../core/clock";
import { hold } from "../core/lock";
import { off } from "../core/outputs";
import { recover, tick } from "./desk-clock";
import { type Desk, openDesk } from "./desk-store";
import type { Runtime } from "./runtimes/contract";

// The desk's helper, `life desk`: its own process (Life.app's supervisor keeps it while `desk` is set), its own lock in
// `MACHINE_DIR` and its own store; never the memory lock. Off, it returns before any of them.

/** The runtimes the desk drives, by name: none until the first one lands (the desk spec, step 3). */
const RUNTIMES: Record<string, Runtime> = {};
/** The clock ticks every 5 s (his answer starts a turn within 15 s); the messages are polled every 6th tick, 30 s. */
const TICK_MS = 5000;
const POLL_EVERY = 6;
/** A tick past this has hung: the helper exits, and the supervisor starts it again. */
const HUNG_AFTER = 5 * MIN;

export async function desk() {
  const why = off("desk");
  if (why) {
    console.log(why);
    return 0;
  }
  await hold("desk");
  const d: Desk = { db: openDesk(), runtimes: RUNTIMES };
  await recover(d);
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
