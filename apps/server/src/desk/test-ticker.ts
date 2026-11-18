import { applyAgentChanges } from "./agent-changes";
import { wakeDue } from "./desk-clock";
import type { Desk } from "./desk-store";

/**
 * The desk ticking for a test, as its clock does (his word applied, then the turns due) every `everyMs`, one tick at a
 * time. `stop` ends it and waits for the tick in flight, so none touches the store after the test.
 */
export function ticking(desk: Desk, everyMs = 300) {
  let inflight: Promise<void> | undefined;
  const timer = setInterval(() => {
    inflight ??= (async () => {
      try {
        await applyAgentChanges(desk);
        await wakeDue(desk);
      } finally {
        inflight = undefined;
      }
    })();
  }, everyMs);
  return async () => {
    clearInterval(timer);
    await inflight;
  };
}
