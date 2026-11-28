import type { Database } from "bun:sqlite";
import { digest } from "../core/hash";
import { NO_LONGER_OPEN } from "../memory/answer-check";
import { inboxOf, isInboxCheck } from "../memory/check-urgency";
import { checksAndKeyNow, checksNow } from "../memory/checks";
import type { Decision } from "../memory/decision-lines";
import { findMessage } from "../memory/find-refs";
import type { HeldRead } from "../memory/life-checks";
import { readIndex } from "../memory/memory-files";
import { readFiles, showFiles } from "../memory/message-files";
import { withPayeeAccountsOf } from "../memory/your-move";
import {
  agentOf,
  beingFixedOf,
  cardOwnersOf,
  complaintsAtWork,
  heldByAgents,
  heldStampOf,
  readDesk,
} from "./desk-read";
import { monthBudgetOf } from "./spending";

// The open checks as every reader sees them (the connector, the app's answers, pushes, the nightly report, the status, the CLI):
// `checksNow` over what registered agents hold, read from the desk's store, which memory cannot read: a cheap stamp for
// its key, the facts only when the list is read again; and his complaints the caretaker holds (a few rows, in its key),
// shown with the caretaker's open card among the decisions the list is read from.

/** Each desk agent's open card as its holder's (its assignment's agent, else its asker): who, and that agent's session now, if any (never a link the card was asked with). */
export const cardHoldersOf = (
  db: Database,
  open: readonly Pick<Decision, "agent" | "id">[]
) => {
  const owners = cardOwnersOf(db, open);
  return open.flatMap((d) => {
    const holder = owners[d.id]?.holder ?? d.agent;
    const agent = holder ? agentOf(db, holder) : null;
    return agent
      ? [
          [
            d.id,
            { agent: agent.id, ...(agent.link ? { session: agent.link } : {}) },
          ] as const,
        ]
      : [];
  });
};

/** What agents hold (`HeldRead`); null while the desk is off or unreadable (then no new matter is offered). */
function readHeld(): HeldRead | null {
  const stamp = readDesk(heldStampOf, "");
  if (stamp.state !== "ok") {
    return null;
  }
  const complaints = readDesk(complaintsAtWork, []);
  const atWork = complaints.state === "ok" ? complaints.value : [];
  return {
    cardHolders: (open) => {
      const r = readDesk((db) => cardHoldersOf(db, open), []);
      return Object.fromEntries(r.state === "ok" ? r.value : []);
    },
    // Over the decisions the list is read from, so a card answered since never shows; the desk unreadable then, the
    // complaints still show as being fixed, without the card (they never block again on a failed read).
    complaints: (decisions) => {
      const r = readDesk((db) => beingFixedOf(db, decisions), []);
      return r.state === "ok"
        ? r.value
        : atWork.map(({ ask, since }) => ({
            ask,
            context: null,
            line: null,
            since,
          }));
    },
    read: () => {
      const r = readDesk(heldByAgents, []);
      return r.state === "ok" ? r.value : null;
    },
    stamp: JSON.stringify([stamp.value, atWork]),
  };
}

/** Every open check now (`checksNow`), of every kind: his inbox, in its order (`inboxOrderOf`). The status's `left` counts them; the badge, what blocks (`blockingCountOf`). */
export const openChecksNow = () => checksNow(readHeld(), monthBudgetOf());

/** His inbox now: the open checks it shows (`isInboxCheck`: an ending check shows on its matter's page only). The badge, pushes, the status's `left`, the nightly and his phone's inbox read it. */
export const inboxChecksNow = async () =>
  (await openChecksNow()).filter(isInboxCheck);

/** Every open check now with the key it was read from (`checksAndKeyNow`): for the connector's versioned reads. */
export const openChecksAndKeyNow = () =>
  checksAndKeyNow(readHeld(), monthBudgetOf());

/** The open check `ref`; throws when none is open. */
export async function openCheckOf(ref: string) {
  const check = (await openChecksNow()).find((c) => c.ref === ref);
  if (!check) {
    throw new Error(NO_LONGER_OPEN);
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
  o: { after?: string; his?: boolean; ifNot?: string; pushId?: string } = {}
) {
  const shown = (await openChecksAndKeyNow()).checks.filter(isInboxCheck);
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
  const checks = o.pushId
    ? shown.filter((c) => c.pushId === o.pushId)
    : shown.slice(from, from + limit);
  return {
    checks: hisChecksOf(checks, o.his),
    ...counts,
    version,
  };
}

/** A step observation's source message as Life read it, its files as lines, unredacted (`withPayeeAccountsOf`'s only reader). */
function readStepSourceText(step: string) {
  const row = readIndex((db) =>
    db
      .query<{ channel: string; ref: string }, [string]>(
        "select channel, ref from observations where id = ?"
      )
      .get(step)
  );
  const found = row && findMessage({ message: row.ref, source: row.channel });
  return found?.found
    ? showFiles([found.event], readFiles())[0]?.text
    : undefined;
}

/** Checks as a reader sees them; `his` (his own app's read: `read_inbox`, `read_matter` on his token) adds the payee's IBAN to his payment cards (`withPayeeAccountsOf`). */
export const hisChecksOf = <
  C extends Parameters<typeof withPayeeAccountsOf>[0][number],
>(
  checks: readonly C[],
  his = false
) => (his ? withPayeeAccountsOf(checks, readStepSourceText) : checks);
