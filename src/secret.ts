import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes a file only its owner reads (the events subscription's secret, the sign-in's key), whole or not at all: to a
 * temporary file beside it, then renamed over it, so a crash mid-write never leaves a key that no longer parses.
 */
export function writeSecret(path: string, text: string) {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
