import { clock, MIN } from "../core/clock";
import { isBridgeAdded, readLogins } from "../sources/matrix";
import { NETWORKS } from "../sources/networks";

// The fix asks (the v4 plan, bundle E): what is broken and needs him, written by code from a fixed list, never by a
// model: a network's bridge signed out, and the month's amount about to be passed. The caretaker takes what is not on
// the list. A health read that fails is never a fix ask: only what the bridge itself says, or what was spent.

/** A login state the bridge won't leave by itself: he must sign in again. */
const SIGNED_OUT = ["BAD_CREDENTIALS", "LOGGED_OUT"];
/** The bridges are asked at most this often: the inbox is read every minute. */
const BRIDGES_EVERY = 5 * MIN;

/** The month's spending against his amount, as host reads it (`monthBudgetOf`). */
export interface MonthBudget {
  isPassed: boolean;
  monthly: number;
  projected: number;
  spent: number;
}

/** One fix ask: its ref (stable while the cause lasts), its words and which of the fix's options it offers. */
export interface Fix {
  context: string;
  options: readonly ("keep" | "later" | "raise")[];
  question: string;
  ref: string;
  title: string;
}

const dollars = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

/**
 * The fix asks, the one list (pure): each network whose bridge is signed out, and the month's amount when its pace
 * would pass it before the month ends and it is not passed yet (asked once: his answer is a Later to the next month).
 */
export function fixesOf(
  signedOut: readonly { label: string; name: string }[],
  budget: MonthBudget | undefined,
  month: string
): Fix[] {
  return [
    ...signedOut.map((n) => ({
      context: `${n.label} signed Life out, so its messages stop reaching Life until you sign in again on your Mac.`,
      options: ["later"] as const,
      question: `Sign in to ${n.label} again?`,
      ref: `fix:signed-out/${n.name}`,
      title: `Sign ${n.label} back in`,
    })),
    ...(budget && !budget.isPassed && budget.projected > budget.monthly
      ? [
          {
            context: `${dollars(budget.spent)} spent so far this month; at this pace Life passes your ${dollars(budget.monthly)} before the month ends. Past it, Life slows its background work; recording and answering never stop.`,
            options: ["raise", "keep"] as const,
            question: `Raise this month's amount to ${dollars(budget.monthly * 2)}?`,
            ref: `fix:budget/${month}`,
            title: "Life's spending this month",
          },
        ]
      : []),
  ];
}

let bridges: { at: number; signedOut: { label: string; name: string }[] } = {
  at: 0,
  signedOut: [],
};

/** The networks whose bridge says he is signed out, read at most every 5 minutes; a bridge that can't be read is none. */
async function readSignedOut() {
  const now = clock().getTime();
  if (now - bridges.at < BRIDGES_EVERY) {
    return bridges.signedOut;
  }
  const read = await Promise.all(
    NETWORKS.filter((n) => isBridgeAdded(n.name)).map(async (n) => {
      const logins = await readLogins(n.name).catch(() => []);
      return logins.some((l) =>
        SIGNED_OUT.includes(
          (l as { state?: { state_event?: string } }).state?.state_event ?? ""
        )
      )
        ? [{ label: n.label, name: n.name }]
        : [];
    })
  );
  bridges = { at: now, signedOut: read.flat() };
  return bridges.signedOut;
}

/** The fix asks now (`fixesOf`), with the month's spending host read (`budget`). */
export const fixesNow = async (
  budget: MonthBudget | undefined,
  today: string
) => fixesOf(await readSignedOut(), budget, today.slice(0, 7));
