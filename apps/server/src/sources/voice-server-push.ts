import { createHmac } from "node:crypto";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import type { Push } from "../core/push";
import { secretIn } from "../core/secret";
import { writeVoiceServer } from "./voice-server";
import { voiceServerMissing } from "./voice-server-call";

/** A card's or an appointment's id for a push (`core/push.ts`): 16 hex of an HMAC of its ref under a key that never leaves the Mac, which the phone reads back from the connector (`read_inbox`, `read_appointments`), never the ref. */
export const pushIdOf = (ref: string, key = secretIn("pushIdKey")) =>
  createHmac("sha256", key).update(ref).digest("hex").slice(0, 16);

/** A push to his phone through the voice server (`POST /notifications`), logged like a correction; nothing without the voice server set up. Never throws: a failure is its log line. Whether the voice server took it. */
export async function notifyPhone(push: Push) {
  if (voiceServerMissing()) {
    return false;
  }
  return await writeVoiceServer("POST", "/notifications", push).then(
    () => true,
    (e) => {
      log("lifelog.write", { ...errorOf(e), phase: "failed" });
      return false;
    }
  );
}
