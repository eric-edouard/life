import { MIN } from "../core/clock";
import { eventKey } from "../records/source";
import type { Unit } from "../records/unit";
import type { Evidence } from "./gather";
import { isDirect, kindOf } from "./sources";
import { type Built, holdsName, isAgentReport, isFromStrangers } from "./units";

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

/** Arrivals the reader reads: chats and mail (voice waits for a measured cut of its own; notes, imports and activity are the night's). */
const ARRIVING = new Set(["chat", "mail"]);
export const isArriving = (source: Unit["source"]) =>
  ARRIVING.has(kindOf(source));

/** Through whatever the rules below say: his words to Life, an agent's report. */
const isAlwaysThrough = ({ b }: Seen) =>
  Boolean(b.unit.marked?.length) ||
  b.messages.some((m) => isAgentReport(m.sender));

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
  ["stranger", ({ b }) => b.messages.length > 0 && isFromStrangers(b)],
];

/** For each of today's units, whether it is due at `now` (with its unread messages) or which rule holds it for the night. */
export function arrivalsDue(
  { built }: Pick<Evidence, "built">,
  read: ArrivalReads,
  now: Date
): GateAnswer[] {
  return built.map((b): GateAnswer => {
    const fresh = b.messages.filter(
      (m) => !read.read.has(eventKey({ id: m.id, source: b.unit.source }))
    );
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
