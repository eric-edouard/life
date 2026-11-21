import { MIN } from "../core/clock";
import { eventKey } from "../records/source";
import type { Unit } from "../records/unit";
import type { Evidence } from "./gather";
import { isDirect, kindOf, sourceOf } from "./sources";
import { type Built, holdsName, isAgentReport, isAutomatedOf } from "./units";

// The arrival gate (docs/glossary.md): which of today's units hold an arrival (new lines no read has shown) worth the
// arrival reader now. Model-free and pure: it decides *when* a unit is read, never *whether*; a unit it holds back waits
// for the night, which reads it as it does today.

/** A chat is still being written while its last line is this recent… */
export const ARRIVAL_QUIET = 2 * MIN;
/** …unless its first unread line has waited this long. */
export const ARRIVAL_AT_MOST = 10 * MIN;

/** What a caller already holds: the message keys a read has shown, and who he is. */
export interface ArrivalReads {
  /** His name and aliases: a group's line that names him is for him. */
  ownerNames: string[];
  /** The keys (`eventKey`) of the messages a read has shown, or that wait for their file's line. */
  read: ReadonlySet<string>;
}

export type GateAnswer =
  | { due: true; fresh: Built["messages"]; unit: Built }
  | { unit: Built; wait: string };

interface Seen {
  b: Built;
  fresh: Built["messages"];
  now: number;
  read: ArrivalReads;
}

/**
 * Arrivals the reader reads: conversations, in chats and mail (voice waits for a measured cut of its own; notes,
 * imports, activity and a work tracker's threads are the night's, and an agent's wait reads a tracker's).
 */
const ARRIVING = new Set(["chat", "mail"]);
const isArriving = (source: Unit["source"]) =>
  ARRIVING.has(kindOf(source)) && !sourceOf(source).isWorkTracker;

/** Through whatever the rules below say: his words to Life. */
const isAlwaysThrough = ({ b }: Seen) => Boolean(b.unit.marked?.length);

/**
 * The lines a read may show, per message (true for anyone, never per thread): not one a read showed, not his agents'
 * report, not an automated message (`isAutomatedOf`), and not another person's line he answered (written before his
 * last line). His own lines stay: never an ask, they are context and where his promises are.
 */
function freshOf(b: Built, read: ArrivalReads) {
  const hisLast = b.messages.findLast((m) => m.fromMe)?.at ?? "";
  return b.messages.filter(
    (m) =>
      !(
        read.read.has(eventKey({ id: m.id, source: b.unit.source })) ||
        isAgentReport(m.sender) ||
        isAutomatedOf(m, b.unit)
      ) &&
      (m.fromMe || m.at > hisLast)
  );
}

/** The proactive-core plan's layer 1 (its 3.3), in order: the first rule that matches holds the unit for the night. */
const RULES: [string, (s: Seen) => boolean][] = [
  [
    "still-written",
    ({ b, fresh, now }) =>
      now - Date.parse(b.unit.end) < ARRIVAL_QUIET &&
      now - Date.parse(fresh[0]?.at ?? b.unit.end) < ARRIVAL_AT_MOST,
  ],
  [
    "group-not-his",
    ({ b, fresh, read }) => {
      const others = new Set(
        b.messages.filter((m) => !m.fromMe).map((m) => m.sender)
      );
      return (
        kindOf(b.unit.source) === "chat" &&
        !isDirect(b.unit.source, b.unit.key, others.size) &&
        !b.messages.some((m) => m.fromMe) &&
        !fresh.some((m) => holdsName(m.text, read.ownerNames))
      );
    },
  ],
];

/** For each of today's units, whether it is due at `now` (with its unread messages) or which rule holds it for the night. */
export function arrivalsDue(
  { built }: Pick<Evidence, "built">,
  read: ArrivalReads,
  now: Date
): GateAnswer[] {
  return built.map((b): GateAnswer => {
    const fresh = freshOf(b, read);
    const wait = waitOf({ b, fresh, now: now.getTime(), read });
    return wait ? { unit: b, wait } : { due: true, fresh, unit: b };
  });
}

/** The rule that holds a unit for the night, or nothing when it is due. */
function waitOf(seen: Seen) {
  if (seen.b.unit.drop) {
    return "dropped";
  }
  if (!isArriving(seen.b.unit.source)) {
    return "night-only";
  }
  if (seen.fresh.length === 0) {
    return "nothing-new";
  }
  return isAlwaysThrough(seen)
    ? undefined
    : RULES.find(([, test]) => test(seen))?.[0];
}
