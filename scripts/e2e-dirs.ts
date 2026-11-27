import { createHash } from "node:crypto";
import { join } from "node:path";

// The phone flows' build and results, one folder per checkout: a worktree never tests another's binary or wipes its run.
const REPO = join(import.meta.dir, "..");
export const E2E_DIR = `/tmp/lifelog-e2e-${createHash("sha256").update(REPO).digest("hex").slice(0, 8)}`;
export const DERIVED = join(E2E_DIR, "dd");
export const RESULT = join(DERIVED, "result.xcresult");
/** FlowTest.shoot's pictures and trees, given to the tests as `PARITY_SHOTS`. */
export const SHOTS = join(E2E_DIR, "parity");
/** `parity --gate`'s exit when it ran nothing (on battery, no board, no green row): shown, never recorded as a pass. */
export const GATE_SKIPPED = 3;
