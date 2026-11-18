import { MIN } from "../core/clock";
import type { Unit } from "../records/unit";
import { closedConversations } from "./extract";
import { isDirect, kindOf } from "./sources";
import { type Built, type Evidence, isAgentReport, nameKey } from "./units";

// The arrival gate (docs/glossary.md): which of today's units hold an arrival (new lines no step has read) worth a day
// pass now. Model-free and pure: it decides *when* a unit is read, never *whether*; a unit it holds back waits for the
// night, which reads it as it does today. Nothing calls it yet: `scripts/arrival-gate-count.ts` measures it.

/** A chat is still being written while its last line is this recent… */
export const ARRIVAL_QUIET = 2 * MIN;
/** …unless its first unread line has waited this long. */
export const ARRIVAL_AT_MOST = 10 * MIN;
/** A recorded conversation of fewer turns is small talk, too short to hold an ask. */
export const SHORT_TURNS = 6;

/** What a caller already holds: how far each unit was read, where a draft was just sent, and who he is. */
export interface ArrivalReads {
  /** The chats a card's draft was sent in during the last hour: their next lines may end a matter. */
  draftChats: Set<string>;
  /** How many of a unit's lines (messages or turns, `stats.items`) a pass has read, by unit id. */
  lines: Map<string, number>;
  /** His name and aliases: a group's line that names him is for him. */
  ownerNames: string[];
}

export type Arrival = { due: true; unit: Unit } | { unit: Unit; wait: string };

interface Seen {
  b: Built;
  fresh: Built["messages"];
  now: number;
  read: ArrivalReads;
}

/** No line from him or from anyone he knows, in a thread he never wrote in. */
const isFromStrangers = (b: Built) =>
  !b.messages.some((m) => m.known || m.fromMe || m.hasOwnerWrittenInThread);

const isNamed = (text: string, names: string[]) =>
  names.some((n) => ` ${nameKey(text)} `.includes(` ${nameKey(n)} `));

/** Arrivals come from voice, chats, mail and agents; notes, imports and activity are the night's (his word, 19 Nov 2026). */
const ARRIVING = new Set(["agent", "chat", "mail", "voice"]);
export const isArriving = (source: Unit["source"]) =>
  ARRIVING.has(kindOf(source));

/** Through whatever the rules below say: his words to Life, an agent's report, a chat a draft was just sent in. */
const isAlwaysThrough = ({ b, read }: Seen) =>
  Boolean(b.unit.marked?.length) ||
  kindOf(b.unit.source) === "agent" ||
  b.messages.some((m) => isAgentReport(m.sender)) ||
  read.draftChats.has(b.unit.key);

/** The proactive-core plan's layer 1 (its 3.3), in order: the first rule that matches holds the unit for the night. */
const RULES: [string, (s: Seen) => boolean][] = [
  [
    "he-did-not-speak",
    ({ b }) => kindOf(b.unit.source) === "voice" && b.unit.stats.fromMe === 0,
  ],
  [
    "small-talk",
    ({ b }) =>
      kindOf(b.unit.source) === "voice" && b.unit.stats.items < SHORT_TURNS,
  ],
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
        !fresh.some((m) => isNamed(m.text, read.ownerNames))
      );
    },
  ],
  [
    "receipt",
    ({ b }) =>
      kindOf(b.unit.source) === "mail" &&
      b.messages.some((m) => m.transaction) &&
      isFromStrangers(b),
  ],
  ["stranger", ({ b }) => b.messages.length > 0 && isFromStrangers(b)],
];

/**
 * For each of today's units, whether it is due for a day pass at `now` or which rule holds it for the night. `read`
 * is what the caller already holds (`ArrivalReads`); `conversations` say which recordings lifelog has settled.
 */
export function arrivalsDue(
  { built, conversations }: Pick<Evidence, "built" | "conversations">,
  read: ArrivalReads,
  now: Date
): Arrival[] {
  const closed = closedConversations(conversations);
  return built.map((b): Arrival => {
    const wait = waitOf(b, {
      closed,
      done: read.lines.get(b.unit.id) ?? 0,
      now: now.getTime(),
      read,
    });
    return wait ? { unit: b.unit, wait } : { due: true, unit: b.unit };
  });
}

/** The rule that holds a unit for the night, or nothing when it is due. */
function waitOf(
  b: Built,
  ctx: Omit<Seen, "b" | "fresh"> & { closed: Set<string>; done: number }
) {
  if (b.unit.drop) {
    return "dropped";
  }
  if (!isArriving(b.unit.source)) {
    return "night-only";
  }
  if (b.unit.stats.items <= ctx.done) {
    return "nothing-new";
  }
  // Timing, not a judgement: lifelog may still regroup it, marked or not.
  if (kindOf(b.unit.source) === "voice" && !ctx.closed.has(b.unit.key)) {
    return "open-conversation";
  }
  const seen = {
    b,
    fresh: b.messages.slice(ctx.done),
    now: ctx.now,
    read: ctx.read,
  };
  return isAlwaysThrough(seen)
    ? undefined
    : RULES.find(([, test]) => test(seen))?.[0];
}
