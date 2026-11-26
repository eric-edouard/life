import { clock, MIN } from "../core/clock";
import { isBridgeAdded, readLogins, signInOf } from "../sources/matrix";
import { NETWORKS } from "../sources/networks";

// The fix asks (the v4 plan, bundle E): what is broken and needs him, written by code from a fixed list, never by a
// model: a network's bridge signed out or never linked, and the month's amount about to be passed. The caretaker takes what is not on
// the list. A health read that fails is never a fix ask: only what the bridge itself says, or what was spent.

/** The bridges are asked at most this often: the inbox is read every minute. */
const BRIDGES_EVERY = 5 * MIN;

/** The month's spending against his amount, as host reads it (`monthBudgetOf`). */
export interface MonthBudget {
  isPassed: boolean;
  monthly: number;
  projected: number;
  spent: number;
}

/** A network he must sign in: its bridge signed him out, or was added and never linked (`signInOf`). */
export interface SignIn {
  label: string;
  name: string;
  state: "never-linked" | "signed-out";
}

/**
 * One fix ask: its ref (stable while the cause lasts), its words, which of the fix's options it offers, and the network
 * its sign-in option signs in (his app opens the sign-in sheet on it: `sign_in_to_network`).
 */
export interface Fix {
  context: string;
  network?: string;
  options: readonly ("keep" | "later" | "raise" | "sign-in")[];
  question: string;
  ref: string;
  title: string;
}

const dollars = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

/** A network's sign-in ask: signed out, or never linked since its bridge was added. */
const signInFixOf = (n: SignIn): Fix =>
  n.state === "signed-out"
    ? {
        context: `${n.label} signed Life out, so its messages stop reaching Life until you sign in again.`,
        network: n.name,
        options: ["sign-in", "later"],
        question: `Sign in to ${n.label} again?`,
        ref: `fix:signed-out/${n.name}`,
        title: `Sign ${n.label} back in`,
      }
    : {
        context: `Life reads and sends your ${n.label} messages once you sign in.`,
        network: n.name,
        options: ["sign-in", "later"],
        question: `Connect ${n.label}?`,
        ref: `fix:not-linked/${n.name}`,
        title: `Connect ${n.label}`,
      };

/**
 * The fix asks, the one list (pure): each network he must sign in, and the month's amount when its pace
 * would pass it before the month ends and it is not passed yet (asked once: his answer is a Later to the next month).
 */
export function fixesOf(
  signIns: readonly SignIn[],
  budget: MonthBudget | undefined,
  month: string
): Fix[] {
  return [
    ...signIns.map(signInFixOf),
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

let bridges: { at: number; signIns: SignIn[] } = { at: 0, signIns: [] };

/** Reads the bridges again at the next ask: he just linked one (`afterLinked`), so its card leaves at once. */
export const forgetBridgeReads = () => {
  bridges = { at: 0, signIns: [] };
};

/** The networks he must sign in, read at most every 5 minutes; a bridge that can't be read is none. */
async function readSignIns() {
  const now = clock().getTime();
  if (now - bridges.at < BRIDGES_EVERY) {
    return bridges.signIns;
  }
  const read = await Promise.all(
    NETWORKS.filter((n) => isBridgeAdded(n.name)).map(async (n) => {
      const logins = await readLogins(n.name).catch(() => undefined);
      const state = logins && signInOf(logins);
      return state ? [{ label: n.label, name: n.name, state }] : [];
    })
  );
  bridges = { at: now, signIns: read.flat() };
  return bridges.signIns;
}

/** The fix asks now (`fixesOf`), with the month's spending host read (`budget`). */
export const fixesNow = async (
  budget: MonthBudget | undefined,
  today: string
) => fixesOf(await readSignIns(), budget, today.slice(0, 7));
