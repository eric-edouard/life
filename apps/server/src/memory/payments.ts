import type { Payment } from "../payments/contract";
import type { Episode } from "../records/episode";
import type { Stay } from "../sources/lifelog";
import { edgeTime, span } from "./episode-span";
import { stayOf, where } from "./places";
import { time } from "./units";
import { localDate } from "./zones";

// Payments placed in his day, at read time (`read_day`, `read_payments`): each one's day in his zone, the episode it
// happened in and where he was. Money decides what a payment is and whether it counts; this only places it.

/** A payment placed: its day, its episode (the smallest one whose time holds it), where he was. */
export interface Placed {
  day: string;
  episode?: Episode;
  payment: Payment;
  stay?: Stay;
}

const MINUTE = 60_000;

/** An episode's time as instants (ms): a timed one's, else its whole days. */
const bounds = (m: Episode) => {
  const s = span(m);
  return [edgeTime(s.allDay, s.from), edgeTime(s.allDay, s.to)] as const;
};

/**
 * Each payment placed among `episodes` and `stays`. Of the episodes holding its time, the shortest (a dinner, not the
 * trip around it), so a payment counts once. One with only its day (Revolut) gets that day and nothing else.
 */
export function place(
  payments: Payment[],
  episodes: Episode[],
  stays: Stay[]
): Placed[] {
  const timed = episodes.map((m) => ({ b: bounds(m), m }));
  return payments.map((payment) => {
    const { paidAt } = payment;
    if (!paidAt) {
      return { day: payment.date, payment };
    }
    const t = Date.parse(paidAt);
    const episode = timed
      .filter(({ b }) => b[0] <= t && t < b[1])
      .sort((x, y) => x.b[1] - x.b[0] - (y.b[1] - y.b[0]))[0]?.m;
    const stay = stayOf(paidAt, new Date(t + MINUTE).toISOString(), stays);
    return {
      day: localDate(paidAt),
      ...(episode ? { episode } : {}),
      payment,
      ...(stay ? { stay } : {}),
    };
  });
}

/** What was paid, in EUR: his spending out less what came back; income and money not his left out. */
export const paid = (list: Placed[]) =>
  list.reduce((n, p) => n - (p.payment.spending ? p.payment.eur : 0), 0);

/** "€1,234": a sum of EUR, whole. */
export const euros = (n: number) => `€${Math.round(n).toLocaleString("en")}`;

/** "-358 THB": an amount as the bank gave it. */
const amount = (p: Payment) =>
  `${p.amount.toLocaleString("en", { maximumFractionDigits: 2 })} ${p.currency}`;

/** A payment as the read path prints it: when, how much, to whom, its category, where he was, its episode. */
export const paymentLine = ({ episode, payment: p, stay }: Placed) =>
  [
    `- ${p.paidAt ? time(p.paidAt) : "(time unknown)"} ${amount(p)}${p.currency === "EUR" ? "" : ` (${euros(-p.eur)} paid)`} ${p.merchant}`,
    p.category ?? "no category yet",
    ...(p.spending ? [] : ["not spending"]),
    ...(stay ? [`at ${where(stay)}`] : []),
    ...(episode ? [`in ${episode.id}`] : []),
  ].join(" · ");
