import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Writes a file only its owner reads (the events subscription's secret, the sign-in's key), whole or not at all: to a
 * temporary file beside it, then renamed over it, so a crash mid-write never leaves a key that no longer parses.
 */
export function writeSecret(path: string, text: string) {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  // Its own temporary name: two processes writing at once never rename each other's.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Whether two secrets are equal, in constant time: compared as bytes (a string's length in characters is not). */
export function same(a: string, b: string) {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A random secret in `path`, made once, exclusively (two first runs at once keep one), then read. */
export function secretIn(path: string) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    try {
      writeFileSync(path, randomBytes(32).toString("hex"), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      // Another process made it first: its key it is.
    }
  }
  return readFileSync(path, "utf8");
}
