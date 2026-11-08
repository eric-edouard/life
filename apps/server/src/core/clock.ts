// Life's one clock: every read of "now" goes through `clock()`, so a test can stop it.
export const clock = () => new Date();

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** An instant in ms, as the ledgers write it. */
export const iso = (ms: number) => new Date(ms).toISOString();

/** The day `days` before `today` (both `YYYY-MM-DD`). */
export const daysBefore = (today: string, days: number) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};
