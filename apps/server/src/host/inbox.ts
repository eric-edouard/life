import { checksNow, inboxOf } from "../memory/checks";
import { heldByAgents, readDesk } from "./desk-read";

// The open checks as every reader sees them (the connector, the app's answers, pushes, the nightly report, the status, the CLI):
// `checksNow` over what registered agents hold now (their steps and projects), read from the desk's store, which memory cannot read.
/** The steps and projects registered agents hold now; null while the desk is off or unreadable (then no new matter is offered). */
function readHeldByAgents() {
  const read = readDesk(heldByAgents, { projects: [], steps: [] });
  return read.state === "ok"
    ? {
        projects: new Set(read.value.projects),
        steps: new Set(read.value.steps),
      }
    : null;
}

/** Every open check now (`checksNow`), of every kind: his inbox, in its order (`inboxRankOf`). The status's `left` counts them; the badge, what blocks (`blockingOf`). */
export const openChecksNow = () => checksNow(readHeldByAgents());

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

/** `read_inbox`: the first `limit` checks of his inbox, what blocks first, then most pressing, with how many there are of each group and how many block. Answered ones leave, so reading again shows the next. */
export async function readInbox(limit: number) {
  const shown = await openChecksNow();
  return { checks: shown.slice(0, limit), ...inboxOf(shown) };
}
