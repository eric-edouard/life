import { createHmac } from "node:crypto";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { secretIn } from "../core/secret";
import { writeLifelog } from "./lifelog";
import { lifelogMissing } from "./lifelog-call";

/** How a push interrupts him: Apple's `interruption-level` (passive: Notification Center only, no sound). */
export type PushLevel = "passive" | "active" | "time-sensitive";

/** A push to his phone through lifelog (`POST /notifications`): words (`title` and `body` together) and/or the `badge`, its `level`, a card's opaque `pushId` (or an appointment's, with `kind` `calendar.added`); or, alone, the `pushId`s of cards that left his inbox (`removed`, a background push). Never his words or a ref. */
export interface Push {
  badge?: number;
  body?: string;
  kind?: "calendar.added";
  level?: PushLevel;
  pushId?: string;
  removed?: string[];
  title?: string;
}

/** A card's or an appointment's id for a push: 16 hex of an HMAC of its ref under a key that never leaves the Mac. The phone reads it back from the connector (`read_inbox`, `read_appointments`); it is never the ref. */
export const pushIdOf = (ref: string, key = secretIn("pushIdKey")) =>
  createHmac("sha256", key).update(ref).digest("hex").slice(0, 16);

/** A push to his phone through lifelog, logged like a correction; nothing without lifelog set up. Never throws: a failure is its log line. Whether lifelog took it. */
export async function notifyPhone(push: Push) {
  if (lifelogMissing()) {
    return false;
  }
  return await writeLifelog("POST", "/notifications", push).then(
    () => true,
    (e) => {
      log("lifelog.write", { ...errorOf(e), phase: "failed" });
      return false;
    }
  );
}
