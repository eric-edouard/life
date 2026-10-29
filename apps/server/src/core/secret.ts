import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LIFE_STATE_DIR } from "./paths";

/**
 * Every secret file Life keeps, in its state: the OAuth issuer's clients and tokens, the agent's events subscription,
 * the key of the app's local reads. Only `writeSecret` and `secretIn` write them, and an export leaves exactly these out
 * (`stage`, export.ts): a secret is known by its place, since not every system has Unix file modes.
 */
export const SECRETS = {
  events: join(LIFE_STATE_DIR, "events.json"),
  localKey: join(LIFE_STATE_DIR, "local.key"),
  /** His account on the bridges' homeserver (`sources/matrix.ts`): `{user, token}`, written once when it is set up. */
  matrix: join(LIFE_STATE_DIR, "matrix.json"),
  /** Life's own sign-in: its key, the apps and their tokens. */
  oauth: join(LIFE_STATE_DIR, "oauth", "state.json"),
};

type Secret = keyof typeof SECRETS;

/**
 * Writes a file only its owner reads (the events subscription's secret, the sign-in's key), whole or not at all: to a
 * temporary file beside it, then renamed over it, so a crash mid-write never leaves a key that no longer parses.
 */
export function writeSecret(name: Secret, text: string) {
  const path = SECRETS[name];
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  // Its own temporary name: two processes writing at once never rename each other's.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Whether `given` is the secret `want`, in constant time, compared as bytes (a string's length in characters is not);
 * never for an empty secret.
 */
export function same(given: string, want: string) {
  const [x, y] = [Buffer.from(given), Buffer.from(want)];
  return y.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

const KEY = /^[0-9a-f]{64}$/;
/**
 * A random secret in its file, made once, then read: written whole to a file of its own, then linked in place, which
 * fails if another process got there first (its key it is), so no reader ever sees half a key or an empty one.
 */
export function secretIn(name: "localKey"): string {
  const path = SECRETS[name];
  if (existsSync(path)) {
    const key = readFileSync(path, "utf8");
    if (KEY.test(key)) {
      return key;
    }
    rmSync(path, { force: true });
  }
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, randomBytes(32).toString("hex"), { mode: 0o600 });
  try {
    linkSync(tmp, path);
  } catch {
    // Linked by another process meanwhile: read its key.
  } finally {
    rmSync(tmp, { force: true });
  }
  return readFileSync(path, "utf8");
}
