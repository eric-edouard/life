import { clock, iso, MIN } from "../../core/clock";

// Background turns pause on a failing model provider (the v4 plan, bundle C, after Nod's `failureWindow`): each run that
// ends on the provider's error doubles the pause, from `PAUSE_FIRST_MS` up to `PAUSE_MOST_MS`, and a run that ends well
// clears it. The pause is the runtime's `paused`, which only the desk's wake of a due turn reads, so a paused turn spends
// no try; his asks, starts and moves never read it. His own asks never arm it (their failure is his to see); one that
// ends well lifts it.

const PAUSE_FIRST_MS = 30_000;
const PAUSE_MOST_MS = 30 * MIN;

export function providerPause() {
  let failures = 0;
  let until = 0;
  return {
    /** Why background turns wait now; none when they may run. */
    block: () =>
      clock().getTime() < until
        ? `the model provider is failing: background turns wait until ${iso(until)}`
        : undefined,
    /** A run ended: on the provider's error (`isProviderError`), or not. */
    heard(isProviderError: boolean) {
      failures = isProviderError ? failures + 1 : 0;
      until = isProviderError
        ? clock().getTime() +
          Math.min(PAUSE_MOST_MS, PAUSE_FIRST_MS * 2 ** (failures - 1))
        : 0;
    },
  };
}
