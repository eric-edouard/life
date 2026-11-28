import { statfsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { MIN } from "../core/clock";
import { readJson, unreadable, writeJson } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { HOME, permissionsHelperPath } from "../core/platform";
import { exec, execOk } from "../core/proc";
import {
  ACCESS_STATUSES,
  AccessStatus,
  type AccessStatuses,
} from "../memory/access";
import type { AccessCheck } from "../records/integration";

// The Mac's side of an access card: its statuses read silently and a missing step shown to him. Every read and prompt
// runs in the permissions helper (`life-eventkit access`), a process Life.app started, so the answer is Life's grant, never
// Terminal's or bun's (macOS gives a child's access to its responsible app). Full Disk Access has no status call: it is
// a read of a file only it opens; free space is the home volume's.

/** A file only Full Disk Access opens: the user's privacy database itself. */
const TCC_DB = join(HOME, "Library/Application Support/com.apple.TCC/TCC.db");
const GB = 1024 ** 3;
/** How long a prompt may wait for his answer on the Mac before its helper gives up. */
const PROMPT_WAIT = 10 * MIN;

/** The panes he turns a step on in (System Settings' own links). */
const PANES: Record<AccessCheck, string> = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  calendars:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  contacts:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
  disk_free: "x-apple.systempreferences:com.apple.settings.Storage",
  full_disk_access:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  photos:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos",
};
/** What the permissions helper reads: the checks with a prompt of their own (Accessibility's is the system's alert, which opens its pane and has no "no", so it is shown again until it is on; the others are asked once, then only their pane turns them on). */
const HelperStatuses = z
  .object({
    accessibility: AccessStatus,
    calendars: AccessStatus,
    contacts: AccessStatus,
    photos: AccessStatus,
  })
  .strict();

const helper = () => {
  const path = permissionsHelperPath();
  if (!path) {
    throw new Error("no permissions helper: Life.app is not running Life");
  }
  return path;
};

/** Whether Full Disk Access is on: read from the one file only it opens, never by asking the helper. */
export const readFullDiskAccess = (): z.infer<typeof AccessStatus> =>
  unreadable(TCC_DB, "no") ? "missing" : "done";

/** The Mac's statuses now, from the helper, the protected file and the disk, written whole to `ACCESS_STATUSES` when they changed (the inbox's key moves with it). */
export async function readAccessNow(): Promise<AccessStatuses> {
  const read = HelperStatuses.parse(
    JSON.parse(await execOk([helper(), "access", "status"]))
  );
  const disk = statfsSync(HOME);
  const now: AccessStatuses = {
    freeGb: Math.floor((disk.bavail * disk.bsize) / GB),
    statuses: {
      ...read,
      full_disk_access: readFullDiskAccess(),
    },
  };
  if (!isDeepStrictEqual(readJson(ACCESS_STATUSES), now)) {
    writeJson(ACCESS_STATUSES, now);
  }
  return now;
}

/**
 * Shows him `check` on the Mac: its prompt while it was never asked (the helper waits for his answer, never awaited
 * here), else its pane in System Settings, where only he turns it on.
 */
export async function showAccessStepOnMac(
  check: AccessCheck,
  status: z.infer<typeof AccessStatus>
) {
  if (status === "missing" && Object.hasOwn(HelperStatuses.shape, check)) {
    exec([helper(), "access", "ask", `--of=${check}`], {
      timeout: PROMPT_WAIT,
    }).then(
      (r) =>
        r.code === 0 ||
        log("run.error", {
          ...errorOf(new Error(r.stderr.trim() || `exit ${r.code}`)),
          step: "access.ask",
        })
    );
    return;
  }
  await execOk(["open", PANES[check]]);
}
