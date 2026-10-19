import { join } from "node:path";
import { readJson } from "./memory/ledger";
import { WATCH } from "./sources/lifelog";

// The watcher's health record (derived/watch/health.json): written by the watcher after every poll, read by
// `bun life status` and the dashboard.

export const ALERT_AFTER_MS = 15 * 60_000;
export const HEALTH = join(WATCH, "health.json");
export const NO_PUBLIC: PublicState = {
  checkedAt: null,
  failures: 0,
  result: null,
};

export interface PublicState {
  checkedAt: string | null;
  failures: number;
  result: "fail" | "offline" | "ok" | null;
}

export interface Health {
  /** When the incident's alert was sent; null when there is none. */
  alertedAt: string | null;
  consecutiveErrors: number;
  cursor: string;
  lagSec: number;
  lastError: string | null;
  lastOkAt: string | null;
  lastPollAt: string;
  public?: PublicState;
}

export const readHealth = () => readJson<Health>(HEALTH) ?? null;

/** The watcher is polling: a good poll in the last 15 minutes. */
export const polling = (h: Health, now = Date.now()) =>
  h.lastOkAt !== null && now - Date.parse(h.lastOkAt) < ALERT_AFTER_MS;
