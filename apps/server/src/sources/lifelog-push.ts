import { log } from "../core/log";
import { writeLifelog } from "./lifelog";
import { lifelogMissing } from "./lifelog-call";

/** How a push interrupts him: Apple's `interruption-level` (passive: Notification Center only, no sound). */
export type PushLevel = "passive" | "active" | "time-sensitive";

/** A push to his phone through lifelog (`POST /notifications`): words (`title` and `body` together) and/or the `badge`, its `level`, a card's opaque `pushId`. Never his words or a ref. */
export interface Push {
  badge?: number;
  body?: string;
  level?: PushLevel;
  pushId?: string;
  title?: string;
}

/**
 * A push to his phone through lifelog, logged like a correction; nothing without lifelog set up. Never throws: a
 * failure is its log line. `removed` alone: the `pushId`s of cards that left his inbox, a background push.
 */
export async function notifyPhone(push: Push | { removed: string[] }) {
  if (lifelogMissing()) {
    return;
  }
  await writeLifelog("POST", "/notifications", push).catch((e) =>
    log("lifelog.write", { error: String(e), phase: "failed" })
  );
}
