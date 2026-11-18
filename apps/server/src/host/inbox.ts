import { checksNow, inboxOf } from "../memory/checks";
import { anchoredSteps, readDesk } from "./desk-read";

// The inbox as every reader sees it (the connector, the app's answers, pushes, the nightly report, the status, the CLI):
// `checksNow` over the steps an agent is anchored on now, read from the desk's store, which memory cannot read.

/** The steps an agent is anchored on now; null while the desk is off or unreadable (then no new matter is offered). */
function readAnchoredSteps() {
  const read = readDesk(anchoredSteps, []);
  return read.state === "ok" ? new Set(read.value) : null;
}

/** Every open check now (`checksNow`). */
export const inboxNow = () => checksNow(readAnchoredSteps());

/** The open check `ref`; throws when none is open. */
export async function openCheckOf(ref: string) {
  const check = (await inboxNow()).find((c) => c.ref === ref);
  if (!check) {
    throw new Error(
      `Not done: no open check ${ref}; \`read_inbox\` lists them.`
    );
  }
  return check;
}

/** The inbox (`read_inbox`): the first `limit` checks, most pressing first, with how many there are of each group; answered ones leave, so reading again shows the next. */
export async function readInbox(limit: number) {
  const list = await inboxNow();
  return { checks: list.slice(0, limit), ...inboxOf(list) };
}
