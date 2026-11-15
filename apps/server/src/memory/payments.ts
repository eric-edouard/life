import { daysBefore } from "../core/clock";
import { redact } from "../core/redact";
import { payments } from "../payments/backend";
import type { Payment } from "../payments/contract";
import type { Episode } from "../records/episode";
import { lifelogMissing, type Stay } from "../sources/lifelog";
import { bounds } from "./episode-span";
import { episodesWhere } from "./memory-files";
import { stayOf, staysOf, where } from "./places";
import { clip } from "./units";
import { meant, who as named, readPeople } from "./who";
import { asData } from "./words";
import { localDate, time } from "./zones";

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

/**
 * Each payment placed among `episodes` and `stays`. Of the episodes holding its time, the shortest (a dinner, not the
 * trip around it), so a payment counts once. One with only its day (Revolut) gets that day and nothing else.
 */
export function place(
  all: Payment[],
  episodes: Episode[],
  stays: Stay[]
): Placed[] {
  const timed = episodes.map((m) => ({ b: bounds(m), m }));
  return all.map((payment) => {
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

const paidMs = (p: Placed) =>
  p.payment.paidAt ? Date.parse(p.payment.paidAt) : Number.NEGATIVE_INFINITY;

/** By day, then instant (a payment with only its day first). */
export const byTime = (a: Placed, b: Placed) =>
  a.day.localeCompare(b.day) || paidMs(a) - paidMs(b);

/** What was paid, in EUR: his spending out less what came back; income and money not his left out. */
export const paid = (list: Placed[]) =>
  list.reduce((n, p) => n - (p.payment.spending ? p.payment.eur : 0), 0);

/** "€1,234" or "-€5": a sum of EUR, whole. */
export const euros = (n: number) => {
  const r = Math.round(n);
  return `${r < 0 ? "-" : ""}€${Math.abs(r).toLocaleString("en")}`;
};

/** "-358 THB": an amount as the bank gave it. */
const amount = (p: Payment) =>
  `${p.amount.toLocaleString("en", { maximumFractionDigits: 2 })} ${p.currency}`;

/** A payment as the read path prints it: when, how much, to whom, its category, what it was, where he was, its episode. */
// The merchant is a third party's words: one line, clipped.
export const paymentLine = ({ episode, payment: p, stay }: Placed) =>
  [
    `- ${p.paidAt ? time(p.paidAt) : "(time unknown)"} ${amount(p)}${p.currency === "EUR" ? "" : ` (${euros(-p.eur)} paid)`} ${clip(redact(p.merchant.replace(/\s+/g, " ")), 80)}`,
    p.category ?? "no category yet",
    ...(p.note ? [`"${clip(redact(p.note.replace(/\s+/g, " ")), 120)}"`] : []),
    ...(p.spending ? [] : ["not spending"]),
    ...(stay ? [`at ${where(stay)}`] : []),
    ...(episode ? [`in ${episode.id}`] : []),
  ].join(" · ");

/**
 * The payments of his days `from` to `to`, placed (`place`): none while payments are off, and the backend's error
 * instead of failing the read. A payment's day is his, so a day either side of the bank's days is read.
 */
export async function placedOn(
  from: string,
  to: string,
  episodes: Episode[],
  stays: Stay[]
): Promise<{ error?: string; list: Placed[] }> {
  const backend = payments();
  if (!backend) {
    return { list: [] };
  }
  try {
    const all = await backend.between(daysBefore(from, 1), daysBefore(to, -1));
    return {
      list: place(all, episodes, stays).filter(
        (p) => p.day >= from && p.day <= to
      ),
    };
  } catch (e) {
    return { error: (e as Error).message, list: [] };
  }
}

/** His stays on each day `from` to `to` (none without lifelog, or when it cannot be read). */
async function staysOn(from: string, to: string) {
  if (lifelogMissing()) {
    return [];
  }
  const days: string[] = [];
  for (let d = from; d <= to; d = daysBefore(d, -1)) {
    days.push(d);
  }
  // One lifelog read per day: its `visits` stops at 200 stays (lifelog `location.ts`), fewer than a month holds.
  const each = await Promise.all(
    days.map((d) => staysOf({ at: d }).catch(() => null))
  );
  return each.flatMap((s) => s ?? []);
}

/** `read_payments`: his payments placed in his days, what each episode cost him, and the people he was with then. */
export async function paymentsOf(q: {
  episode?: string;
  from: string;
  to?: string;
  who?: string;
}) {
  const to = q.to ?? q.from;
  const [episodes, stays, folks] = await Promise.all([
    episodesWhere(() => true),
    staysOn(q.from, to),
    readPeople(),
  ]);
  const ofDays = await placedOn(q.from, to, episodes, stays);
  if (ofDays.error) {
    return `Payments unknown: ${ofDays.error}`;
  }
  const ref = q.who && meant(q.who, folks).known;
  if (q.who && !ref) {
    return `No one goes by ${q.who}.`;
  }
  const list = ofDays.list.filter(
    (p) =>
      (!q.episode || p.episode?.id === q.episode) &&
      (!ref || p.episode?.people.some((x) => x.ref === `person:${ref}`))
  );
  const byEpisode = [
    ...Map.groupBy(
      list.filter((p) => p.episode),
      (p) => p.episode as Episode
    ),
  ]
    .map(([m, l]) => ({ m, n: l.length, paid: paid(l) }))
    .sort((a, b) => b.paid - a.paid);
  const byPerson = new Map<string, number>();
  for (const { m, paid: spent } of byEpisode) {
    for (const x of m.people.filter((y) => y.role === "with")) {
      byPerson.set(x.ref, (byPerson.get(x.ref) ?? 0) + spent);
    }
  }
  return asData([
    `Payments ${q.from}${to === q.from ? "" : ` to ${to}`}: ${list.length}, ${euros(paid(list))} paid (EUR at today's rate; money decides what counts):`,
    ...list.toSorted(byTime).map((p) => `${p.day} ${paymentLine(p).slice(2)}`),
    "",
    "Paid per episode (most first):",
    ...byEpisode.map(
      ({ m, paid: spent, n }) =>
        `- ${m.id} ${m.title} (${m.day}): ${euros(spent)}, ${n} payment${n === 1 ? "" : "s"}`
    ),
    "",
    "Paid in the episodes each person was in (the whole, not their share):",
    ...[...byPerson]
      .sort((a, b) => b[1] - a[1])
      .map(([r, spent]) => `- ${named({ speaker: r })}: ${euros(spent)}`),
  ]);
}
