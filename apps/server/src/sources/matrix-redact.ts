import type { RoomFeatures } from "./matrix-content";

// His Undo of a message Life sent into a bridged room (`unsendDraft`): a Matrix redaction, which the bridge passes on as
// the network's delete for everyone, only where the room's own features allow it now (`delete`, `delete_max_age`,
// mautrix's `RoomFeatures`), never a table of Life's.

/** What the other side sees when Life deletes his message sent at `sentAt` for everyone now, as the room's features allow; none when they don't. */
export function deleteLineOf(
  f: RoomFeatures | undefined,
  sentAt: string,
  now: Date
) {
  const isTooOld =
    f?.delete_max_age !== undefined &&
    now.getTime() - Date.parse(sentAt) > f.delete_max_age * 1000;
  return (f?.delete ?? 0) >= 1 && !isTooOld
    ? "It is deleted for both of you; they see that a message was deleted."
    : undefined;
}

/**
 * Redacts his message `event` in `room` as him (`at`'s homeserver and token), then waits up to `at.confirmMs` for the
 * bridge's own record of it to go (`isGone`): deleted only once the bridge confirmed it. Throws why not.
 */
export async function redact(
  room: string | undefined,
  event: string | undefined,
  at: { confirmMs: number; homeserver: string; token?: string },
  isGone: () => boolean
) {
  if (!(at.token && room && event)) {
    throw new Error("not deleted: the bridge holds no such message");
  }
  const res = await fetch(
    `${at.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/redact/${encodeURIComponent(event)}/${encodeURIComponent(`undo-${event}`)}`,
    {
      body: "{}",
      headers: {
        Authorization: `Bearer ${at.token}`,
        "Content-Type": "application/json",
      },
      method: "PUT",
      signal: AbortSignal.timeout(10_000),
    }
  ).catch((e: Error) => {
    throw new Error(`not deleted: the homeserver didn't answer: ${e.message}`);
  });
  if (!res.ok) {
    throw new Error(`not deleted: the homeserver refused it: ${res.status}`);
  }
  for (let waited = 0; waited < at.confirmMs; waited += 500) {
    if (isGone()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling the bridge's own record
    await Bun.sleep(500);
  }
  throw new Error(
    "may not be deleted: the bridge didn't confirm it: read the chat"
  );
}
