import { inboxOf } from "../memory/check-urgency";
import { checksNow, type HeldRead } from "../memory/checks";
import { heldByAgents, heldStampOf, readDesk } from "./desk-read";

// The open checks as every reader sees them (the connector, the app's answers, pushes, the nightly report, the status, the CLI):
// `checksNow` over what registered agents hold, read from the desk's store, which memory cannot read: a cheap stamp for
// its key, the facts only when the list is read again.
/** What agents hold (`HeldRead`); null while the desk is off or unreadable (then no new matter is offered). */
function readHeld(): HeldRead | null {
  const stamp = readDesk(heldStampOf, "");
  if (stamp.state !== "ok") {
    return null;
  }
  return {
    read: () => {
      const r = readDesk(heldByAgents, []);
      return r.state === "ok" ? r.value : null;
    },
    stamp: stamp.value,
  };
}

/** Every open check now (`checksNow`), of every kind: his inbox, in its order (`inboxOrderOf`). The status's `left` counts them; the badge, what blocks (`blockingCountOf`). */
export const openChecksNow = () => checksNow(readHeld());

/** The open check `ref`; throws when none is open. */
export async function openCheckOf(ref: string) {
  const check = (await openChecksNow()).find((c) => c.ref === ref);
  if (!check) {
    throw new Error(
      `Not done: no open check ${ref}; \`read_inbox\` lists them.`
    );
  }
  return check;
}

/** `read_inbox`: the first `limit` checks of his inbox, what blocks first, then most pressing, with how many there are of each group and how many block. Answered ones leave, so reading again shows the next. With `pushId` (a push's), only that card, or none when it is answered; the counts stay the whole inbox's. */
export async function readInbox(limit: number, pushId?: string) {
  const shown = await openChecksNow();
  return {
    checks: pushId
      ? shown.filter((c) => c.pushId === pushId)
      : shown.slice(0, limit),
    ...inboxOf(shown),
  };
}
