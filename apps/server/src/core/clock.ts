// Life's one clock: every read of "now" goes through `clock()`, so a test can stop it.
export const clock = () => new Date();

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** An instant in ms, as the ledgers write it. */
export const iso = (ms: number) => new Date(ms).toISOString();
