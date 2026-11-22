import { HOUR, MIN } from "../core/clock";
import { dayNow, localDate, localTime, time } from "../memory/zones";
import type { AppListing } from "./claude-app-listing";
import { OPEN_IN_WORDS, type SessionOpenIn } from "./open-session-records";

// The agents' health (his word of 22 Nov 2026: "an extensive health check of the agents ... that they're really
// listening ... visible on the app for Claude Code"): a verdict per agent and one for the desk, in plain words, worked out
// when read from what the agents' read already holds (`AgentNow`, its amber), never stored. Pure: the reads are the callers'.

/** Fine; needs attention (it works, something is off); broken (it can't do its job until something changes). */
export type HealthVerdict = "fine" | "attention" | "broken";
export interface Health {
  verdict: HealthVerdict;
  /** Why, in plain words, the broken ones first; none when fine. */
  why: string[];
}

/** Queued events unheard this long: not listening (an event wakes its agent within 10 minutes, `nextWakeOf`). */
const DEAF_AFTER = 30 * MIN;
const DEAF_BROKEN_AFTER = 2 * HOUR;
/** A session held open elsewhere with wakes waiting this long: broken. */
const HELD_BROKEN_AFTER = HOUR;
/** Turns failed in a row: broken. */
const FAILED_BROKEN = 3;

/** What an agent's health reads. */
export interface HealthFacts {
  amber: string[];
  /** Where his Claude app lists its session (a Claude agent of his own Life with a session); null: not judged. */
  app: AppListing | null;
  failedInARow: number;
  notStarted: string | null;
  runtime: string;
  /** Why its runtime can't run at the desk's last look (`runtime_block`); null or absent: it ran. */
  runtimeBlock: string | null | undefined;
  sessionOpenIn: SessionOpenIn | null;
  sessionOpenSince: string | null;
  status: string;
  /** Its oldest event not yet handed to a turn. */
  waitingSince: string | null;
}

/** A time as he reads it: its hour today, else its day too. */
const whenOf = (iso: string) =>
  localDate(iso) === dayNow() ? time(iso) : localTime(iso);

/** The amber flags (`amberOf`) as he reads them; the session held open is said with its wakes instead. */
const amberWords = (flag: string) => {
  if (flag.startsWith("session open")) {
    return [];
  }
  const words: Record<string, string> = {
    "deadline late": "Its deadline passed with no turn.",
    "default wait": "Its last turn ended without saying what it waits for.",
    "last turn failed": "Its last turn failed.",
    "turn silent over an hour": "Its turn has been silent for over an hour.",
  };
  return [words[flag] ?? `${flag[0]?.toUpperCase()}${flag.slice(1)}.`];
};

const ofHealth = (broken: string[], attention: string[]): Health => {
  if (broken.length > 0) {
    return { verdict: "broken", why: [...broken, ...attention] };
  }
  return attention.length > 0
    ? { verdict: "attention", why: attention }
    : { verdict: "fine", why: [] };
};

/** An agent's health: only an active one (running or waiting) is judged; stopped and ended are his or done. */
export function agentHealthOf(f: HealthFacts, now: number): Health {
  if (f.status !== "running" && f.status !== "waiting") {
    return { verdict: "fine", why: [] };
  }
  const broken: string[] = [];
  const attention: string[] = [];
  if (f.runtimeBlock) {
    broken.push(`${f.runtime} can't run: ${f.runtimeBlock}`);
  }
  if (f.notStarted) {
    broken.push(`It never started: ${f.notStarted}`);
  }
  if (f.failedInARow >= FAILED_BROKEN) {
    broken.push(`Its last ${f.failedInARow} turns failed.`);
  }
  const heard = hearingOf(f, now);
  if (heard) {
    (heard.isBroken ? broken : attention).push(heard.line);
  }
  attention.push(
    ...f.amber
      .filter((x) => x !== "last turn failed" || f.failedInARow < FAILED_BROKEN)
      .flatMap(amberWords)
  );
  // Listed only once he continued it there ("Continue on your Mac"): unlisted is no fault.
  if (f.app?.listed && !f.app.inGroup) {
    attention.push("Not in the Life Agents group of your Claude app.");
  }
  return ofHealth(broken, attention);
}

/** Whether what comes for it is heard: its session held open elsewhere (its wakes wait), or events unheard too long. */
function hearingOf(f: HealthFacts, now: number) {
  const waited = f.waitingSince ? now - Date.parse(f.waitingSince) : 0;
  const since = f.waitingSince ? whenOf(f.waitingSince) : "";
  if (f.sessionOpenIn) {
    const held = `Open in ${OPEN_IN_WORDS[f.sessionOpenIn]}${f.sessionOpenSince ? ` since ${whenOf(f.sessionOpenSince)}` : ""}`;
    return {
      isBroken: waited > HELD_BROKEN_AFTER,
      line:
        waited > 0
          ? `${held}; its wakes wait since ${since}: close it there.`
          : `${held}: its wakes wait until you close it there.`,
    };
  }
  return waited > DEAF_AFTER && f.status === "waiting"
    ? {
        isBroken: waited > DEAF_BROKEN_AFTER,
        line: `Not listening: what came for it has waited since ${since}.`,
      }
    : null;
}

/** What the desk's health reads: whether it is on and readable, its helper, the standing roles, the Life plugin. */
export interface DeskHealthFacts {
  desk: "ok" | "off" | "unreadable";
  helper: "running" | "not running";
  /** Whether the Life plugin is on in Claude Code: none when no agent runs on Claude (not judged). */
  isPluginOn?: boolean;
  /** The roles that must stand (`standUp`) and have no agent active or stopped. */
  missingRoles: readonly string[];
}

/** The roles the desk keeps standing from its start (`standUp`). */
export const STANDING_ROLES = ["main", "caretaker"] as const;

const ROLE_WORDS: Record<string, string> = {
  caretaker: "No caretaker: your complaints have no one to fix them.",
  main: "No main session: Ask Life can't answer.",
};

/** The desk's own health, beside each agent's: off, unreadable, its helper down, a standing role missing, the plugin off. */
export function deskHealthOf(f: DeskHealthFacts): Health {
  if (f.desk === "off") {
    return { verdict: "broken", why: ["The desk is off: no agent runs."] };
  }
  if (f.desk === "unreadable") {
    return {
      verdict: "broken",
      why: ["The desk's store can't be read."],
    };
  }
  return ofHealth(
    [
      ...(f.helper === "running"
        ? []
        : ["The desk is not running on the Mac: no agent wakes."]),
      ...f.missingRoles.map((r) => ROLE_WORDS[r] ?? `No ${r} agent.`),
    ],
    f.isPluginOn === false
      ? [
          "The Life plugin is off in Claude Code: an agent's session you open by hand has no send guard.",
        ]
      : []
  );
}
