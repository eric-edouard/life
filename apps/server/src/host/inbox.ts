import {
  checksNow,
  inboxOf,
  type WhereAsked,
  whereAskedOf,
} from "../memory/checks";
import { anchoredSteps, readDesk } from "./desk-read";

// The open checks as every reader sees them (the connector, the app's answers, pushes, the nightly report, the status, the CLI):
// `checksNow` over the steps an agent is anchored on now, read from the desk's store, which memory cannot read. His inbox
// is the part asked there (`whereAskedOf`).

/** The steps an agent is anchored on now; null while the desk is off or unreadable (then no new matter is offered). */
function readAnchoredSteps() {
  const read = readDesk(anchoredSteps, []);
  return read.state === "ok" ? new Set(read.value) : null;
}

/** Every open check now (`checksNow`), of every kind: where each is asked is `whereAskedOf`. */
export const openChecksNow = () => checksNow(readAnchoredSteps());

const askedIn = <
  C extends { kind: Parameters<typeof whereAskedOf>[0]["kind"] },
>(
  list: C[],
  where: WhereAsked
) => list.filter((c) => whereAskedOf(c) === where);

/** His inbox: the open checks asked there (`whereAskedOf`: his agents' decisions). Pushes, the badge and the status's `left` count these. */
export const inboxNow = async () => askedIn(await openChecksNow(), "inbox");

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

/** `read_inbox`: the first `limit` checks of `list` (his inbox, or the ones Life asks when he likes), most pressing first, with how many there are of each group; and always `toConfirm`, how many wait in that list. Answered ones leave, so reading again shows the next. */
export async function readInbox(
  limit: number,
  list: Exclude<WhereAsked, "matter"> = "inbox"
) {
  const open = await openChecksNow();
  const shown = askedIn(open, list);
  return {
    checks: shown.slice(0, limit),
    ...inboxOf(shown),
    toConfirm: askedIn(open, "to confirm").length,
  };
}
