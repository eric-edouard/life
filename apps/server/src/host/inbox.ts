import type { Database } from "bun:sqlite";
import { digest } from "../core/hash";
import { inboxOf } from "../memory/check-urgency";
import { checksAndKeyNow, checksNow } from "../memory/checks";
import type { Decision } from "../memory/decision-lines";
import type { HeldRead } from "../memory/life-checks";
import {
  agentOf,
  assignmentOf,
  assignmentOfCard,
  complaintsAtWork,
  heldByAgents,
  heldStampOf,
  readDesk,
} from "./desk-read";

// The open checks as every reader sees them (the connector, the app's answers, pushes, the nightly report, the status, the CLI):
// `checksNow` over what registered agents hold, read from the desk's store, which memory cannot read: a cheap stamp for
// its key, the facts only when the list is read again; and his complaints the caretaker holds (a few rows, in its key).

/**
 * The plan cards among the open decisions of `list` (every decision, in the order asked): an assignment he opened, its
 * first card not withdrawn (the door's `hasAsked`); never the caretaker's, whose plan is his complaint, nor a hand-out's
 * one card (the desk opened it: what it found, not a plan). Worked out when read, never stored.
 */
export function planCardsOf(db: Database, list: readonly Decision[]) {
  // One pass in the order asked: each assignment's first card not withdrawn, kept when open and his.
  const firsts = new Map<string, Decision>();
  for (const d of list) {
    const s = d.state === "withdrawn" ? null : assignmentOfCard(db, d);
    if (s && !firsts.has(s)) {
      firsts.set(s, d);
    }
  }
  return new Set(
    [...firsts].flatMap(([s, d]) => {
      const opened = d.state === "open" ? assignmentOf(db, s) : null;
      return opened?.opened_by === "owner" &&
        agentOf(db, opened.agent_id)?.role !== "caretaker"
        ? [d.id]
        : [];
    })
  );
}

/** What agents hold (`HeldRead`); null while the desk is off or unreadable (then no new matter is offered). */
function readHeld(): HeldRead | null {
  const stamp = readDesk(heldStampOf, "");
  if (stamp.state !== "ok") {
    return null;
  }
  const complaints = readDesk(complaintsAtWork, []);
  return {
    complaints: complaints.state === "ok" ? complaints.value : [],
    plans: (decisions) => {
      const r = readDesk((db) => planCardsOf(db, decisions), new Set<string>());
      return r.state === "ok" ? r.value : new Set();
    },
    read: () => {
      const r = readDesk(heldByAgents, []);
      return r.state === "ok" ? r.value : null;
    },
    stamp: stamp.value,
  };
}

/** Every open check now (`checksNow`), of every kind: his inbox, in its order (`inboxOrderOf`). The status's `left` counts them; the badge, what blocks (`blockingCountOf`). */
export const openChecksNow = () => checksNow(readHeld());

/** Every open check now with the key it was read from (`checksAndKeyNow`): for the connector's versioned reads. */
export const openChecksAndKeyNow = () => checksAndKeyNow(readHeld());

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

/** A connector read's `version`: a short digest of what it answers from (the inbox's list, the matters' answer). */
export const versionOf = (text: string) => digest("sha256", text, 16);

/** Each list's version, worked out once: a list is read once per checks' key (every call while a run holds the lock) and never mutated. */
const listVersions = new WeakMap<readonly object[], string>();
const listVersionOf = (list: readonly object[]) => {
  const version = listVersions.get(list) ?? versionOf(JSON.stringify(list));
  listVersions.set(list, version);
  return version;
};

/** A versioned read's answer when the caller already holds its `version` (`ifNot`). */
export const unchangedOf = (version: string) => ({
  unchanged: true as const,
  version,
});

/**
 * `read_inbox`: `limit` checks of his inbox, after the card `after` (else from the first), what blocks first, then most
 * pressing, with how many there are of each group and how many block, and the inbox's `version`: its order holds while
 * the version does. Answered ones leave, so reading again shows the next. With `pushId` (a push's), only that card, or
 * none when it is answered; the counts stay the whole inbox's. With `ifNot` its version, only `unchangedOf` it.
 */
export async function readInbox(
  limit: number,
  o: { after?: string; ifNot?: string; pushId?: string } = {}
) {
  const { checks: shown } = await openChecksAndKeyNow();
  const from = o.after ? shown.findIndex((c) => c.ref === o.after) + 1 : 0;
  if (from === 0 && o.after) {
    throw new Error(
      `No open check ${o.after}: the inbox changed, read it from the start.`
    );
  }
  // The answer's own version, never the key's: under the lock a card can change under the same files' stamp (life#779),
  // and the counts change with his day (what is due today) while the cards stay the same.
  const counts = inboxOf(shown);
  const version = versionOf(
    JSON.stringify([listVersionOf(shown), counts.deadlinesToday])
  );
  if (o.ifNot === version) {
    return unchangedOf(version);
  }
  return {
    checks: o.pushId
      ? shown.filter((c) => c.pushId === o.pushId)
      : shown.slice(from, from + limit),
    ...counts,
    version,
  };
}
