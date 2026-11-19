import { log } from "../core/log";
import { lifelogMissing, writeLifelog } from "./lifelog";

/** A push to his phone through lifelog (`POST /notifications`): words (`title` and `body` together) and/or the `badge`, a card's opaque `pushId`. Never his words or a ref. */
export interface Push {
  badge?: number;
  body?: string;
  pushId?: string;
  title?: string;
}

/** A push to his phone through lifelog, logged like a correction; nothing without lifelog set up. Never throws: a failure is its log line. */
export async function notifyPhone(push: Push) {
  if (lifelogMissing()) {
    return;
  }
  await writeLifelog("POST", "/notifications", push).catch((e) =>
    log("lifelog.write", { error: String(e), phase: "failed" })
  );
}
