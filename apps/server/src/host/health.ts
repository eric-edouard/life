import { join } from "node:path";
import { clock, MIN } from "../core/clock";
import { readJson } from "../core/files";
import { WATCH } from "../sources/lifelog";

// The watcher's health record (derived/watch/health.json): written by the watcher after every poll, read by
// `bun life status` and the dashboard.

const POLLING_MS = 15 * MIN;
export const HEALTH = join(WATCH, "health.json");

export interface Health {
  consecutiveErrors: number;
  cursor: string;
  lagSec: number;
  lastError: string | null;
  lastOkAt: string | null;
  lastPollAt: string;
}

export const readHealth = () => readJson<Health>(HEALTH) ?? null;

/** The watcher is polling: a good poll in the last 15 minutes. */
export const polling = (h: Health, now = clock().getTime()) =>
  h.lastOkAt !== null && now - Date.parse(h.lastOkAt) < POLLING_MS;
