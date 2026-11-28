// Life's one clock: every read of "now" goes through `clock()`, so a test can stop it.
export const clock = () => new Date();

export const SECOND = 1000;
export const MIN = 60 * SECOND;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** An instant in ms, as the ledgers write it. */
export const iso = (ms: number) => new Date(ms).toISOString();

/** The build number, the UTC build time as `YYYYMMDD.HHMM`: it only grows. */
export const buildNumber = () => {
  const now = clock().toISOString();
  return `${now.slice(0, 10).replaceAll("-", "")}.${now.slice(11, 16).replace(":", "")}`;
};

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
