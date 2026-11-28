/**
 * A second Life's frozen instant (`LIFE_NOW`, an ISO instant): a question case's copy reads the same "now" on every
 * run, so the same ask reads the same lines. Never with his own data (`platform.ts` refuses it there).
 */
const FROZEN = (() => {
  const set = process.env.LIFE_NOW;
  if (!set) {
    return null;
  }
  const at = Date.parse(set);
  if (Number.isNaN(at)) {
    throw new Error(`LIFE_NOW is not an instant: ${set}`);
  }
  return at;
})();

// Life's one clock: every read of "now" goes through `clock()`, so a test can stop it.
export const clock = () => (FROZEN === null ? new Date() : new Date(FROZEN));

export const SECOND = 1000;
export const MIN = 60 * SECOND;
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

/** "1 h 38 min", "12 min". */
export function minutes(ms: number) {
  const m = Math.round(ms / MIN);
  return m < 60
    ? `${m} min`
    : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
