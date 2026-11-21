import { clock, daysBefore } from "../core/clock";
import { matterFinderOf } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import type { TurnSpent } from "../memory/spends";
import {
  type Basis,
  type Spend,
  type SpendKind,
  type SpendProvider,
  spendOfTurn,
} from "../memory/spends";
import { readPeople } from "../memory/who";
import { dayNow, dayRange } from "../memory/zones";
import { anchorsOf, readDesk } from "./desk-read";
import { sessionTurnsOf, stepTurnsOf, turnsEndedIn } from "./desk-turn-reads";
import {
  type DaySpending,
  type KindSpending,
  type ProviderSpending,
  readDaySpends,
  readSpendingDay,
  spendingOf,
} from "./spending";

// `read_spending` and the `spending` of an agent's and a matter's reads (decision 83's wire, canvas v126): billed
// dollars and his plans' tokens at list price (`equivalent`) are two bases, never summed. Agents and matters run on his
// plans: tokens and their equivalent only.

/** An amount on one basis. */
interface Amount<B extends Basis> {
  amount: number;
  basis: B;
  currency: "USD";
}
const amountOf = <B extends Basis>(usd: number, basis: B): Amount<B> => ({
  amount: Math.round(usd * 1e4) / 1e4,
  basis,
  currency: "USD",
});
/** How many agents and matters `read_spending` ranks, by tokens. */
const TOP = 5;

const billedOf = (d: Pick<DaySpending, "byProvider">) =>
  d.byProvider.reduce((n, p) => n + p.billedUsd, 0);

/** A local day's spending: its file, else read live from its records (today, or a closed day the night has not rolled up); none when it can't be read. */
async function dayOf(day: string, isLive: boolean) {
  const kept = readSpendingDay(day);
  if (kept || !isLive) {
    return kept;
  }
  try {
    return { ...spendingOf((await readDaySpends(day)).spends), day };
  } catch {
    // ponytail: a live day whose desk or Voice read fails is left out of this read, like a day with no record.
  }
}

function merged<T extends ProviderSpending | KindSpending>(
  parts: T[],
  keyOf: (t: T) => string
) {
  const by = new Map<string, T>();
  for (const t of parts) {
    const was = by.get(keyOf(t));
    by.set(
      keyOf(t),
      was
        ? {
            ...was,
            billedUsd: was.billedUsd + t.billedUsd,
            calls: was.calls + t.calls,
            equivalentUsd: was.equivalentUsd + t.equivalentUsd,
            tokens: was.tokens + t.tokens,
            ...("reported" in was && "reported" in t
              ? { reported: was.reported && t.reported }
              : {}),
          }
        : t
    );
  }
  return [...by.values()];
}

const tokenSum = (spends: Spend[]) =>
  spends.reduce(
    (n, s) => n + (s.tokens ? s.tokens.input + s.tokens.output : 0),
    0
  );
const equivalentSum = (spends: Spend[]) =>
  spends.reduce((n, s) => n + (s.equivalentUsd ?? 0), 0);

/** Turns summed by `keyOf`, ranked by tokens, the first `TOP`. */
function topOf(spends: Spend[], keyOf: (s: Spend) => string | undefined) {
  const by = new Map<string, Spend[]>();
  for (const s of spends) {
    const key = keyOf(s);
    if (key) {
      by.set(key, [...(by.get(key) ?? []), s]);
    }
  }
  return [...by]
    .map(([key, list]) => ({
      equivalent: amountOf(equivalentSum(list), "equivalent"),
      key,
      tokens: tokenSum(list),
    }))
    .toSorted((a, b) => b.tokens - a.tokens)
    .slice(0, TOP);
}

/** The month's agents and matters by their turns' tokens: an agent by its name, a matter by its assignment's anchors (the one rule `tokenRowsOf` follows). */
async function readTops(from: string, to: string) {
  const read = readDesk(
    (db) => {
      const turns = turnsEndedIn(db, from, to);
      const ids = [...new Set(turns.map((t) => t.agent_id))];
      if (ids.length === 0) {
        return { anchors: [], names: [], turns };
      }
      const names = db
        .query<{ brief: string; id: string; name: string | null }, string[]>(
          `select id, name, brief from agent where id in (${ids.map(() => "?").join(",")})`
        )
        .all(...ids);
      const anchors = [...new Set(turns.map((t) => t.assignment_id))].map(
        (id) => [id, anchorsOf(db, id)] as const
      );
      return { anchors, names, turns };
    },
    { anchors: [], names: [], turns: [] }
  );
  if (read.state !== "ok" || read.value.turns.length === 0) {
    return { topAgents: [], topMatters: [] };
  }
  const { anchors, names, turns } = read.value;
  const spends = turns.map(spendOfTurn);
  const nameOf = new Map(
    names.map((a) => [a.id, a.name ?? a.brief.trim().split("\n")[0] ?? a.id])
  );
  const find = matterFinderOf(
    await readMatterBook(await readPeople(), dayNow())
  );
  const anchorsOfAsg = new Map(anchors);
  return {
    topAgents: topOf(spends, (s) => s.agent).map(({ key, ...t }) => ({
      agent: nameOf.get(key) ?? key,
      ...t,
    })),
    topMatters: topOf(
      spends,
      (s) => find(anchorsOfAsg.get(s.assignment ?? "") ?? [])?.name
    ).map(({ key, ...t }) => ({ matter: key, ...t })),
  };
}

/** `read_spending`: his month (default the current one), each day of it held, today always; billed and equivalent apart. */
export async function readSpending(month = dayNow().slice(0, 7)) {
  const today = dayNow();
  const isCurrent = month === today.slice(0, 7);
  // A past month ends the day before the next month's first.
  const end = isCurrent
    ? today
    : daysBefore(`${daysBefore(`${month}-28`, -4).slice(0, 7)}-01`, 1);
  const days: string[] = [];
  for (let d = `${month}-01`; d <= end; d = daysBefore(d, -1)) {
    days.push(d);
  }
  const held = (
    await Promise.all(days.map((d) => dayOf(d, isCurrent)))
  ).flatMap((d) => (d ? [d] : []));
  const todays = isCurrent
    ? held.find((d) => d.day === today)
    : await dayOf(today, true);
  const providers = merged(
    held.flatMap((d) => d.byProvider),
    (p) => p.provider
  );
  const kinds = merged(
    held.flatMap((d) => d.byKind),
    (k) => k.kind
  );
  const { from = "", to } = dayRange(`${month}-01`, end);
  return {
    byKind: kinds.map((k) => ({
      billed: amountOf(k.billedUsd, "billed"),
      kind: k.kind as SpendKind,
      ...(k.tokens > 0 ? { tokens: k.tokens } : {}),
    })),
    byProvider: providers.map((p) => ({
      provider: p.provider as SpendProvider,
      ...(p.basis === "billed"
        ? { billed: amountOf(p.billedUsd, "billed") }
        : { equivalent: amountOf(p.equivalentUsd, "equivalent") }),
      ...(p.tokens > 0 ? { tokens: p.tokens } : {}),
      reported: p.reported,
    })),
    days: held.map((d) => ({
      billed: amountOf(billedOf(d), "billed"),
      day: d.day,
    })),
    month: amountOf(
      held.reduce((n, d) => n + billedOf(d), 0),
      "billed"
    ),
    observedAt: clock().toISOString(),
    today: amountOf(todays ? billedOf(todays) : 0, "billed"),
    ...(await readTops(from, to)),
  };
}

/** Turns as `{tokens, equivalent}`: the spending of a matter's read, and the base of an agent's. */
const turnSpendingOf = (turns: TurnSpent[]) => {
  const spends = turns.map(spendOfTurn);
  return {
    equivalent: amountOf(equivalentSum(spends), "equivalent"),
    tokens: tokenSum(spends),
  };
};

/** Each agent's spending in its current session (`read_registered_agents`): since, tokens, equivalent, its runtime. */
export function readAgentSpending(agents: { id: string; runtime: string }[]) {
  const read = readDesk(
    (db) =>
      sessionTurnsOf(
        db,
        agents.map((a) => a.id)
      ),
    { sessions: [], turns: [] }
  );
  const { sessions, turns } =
    read.state === "ok" ? read.value : { sessions: [], turns: [] };
  return new Map(
    agents.map((a) => [
      a.id,
      {
        ...turnSpendingOf(turns.filter((t) => t.agent_id === a.id)),
        provider:
          a.runtime === "codex" ? ("codex" as const) : ("claude" as const),
        since: sessions.find((s) => s.agent_id === a.id)?.started_at ?? null,
      },
    ])
  );
}

/** A matter's spending (`read_matter`): its assignments' turns, since its first step. */
export function readMatterSpending(steps: string[]) {
  const read = readDesk((db) => stepTurnsOf(db, steps), []);
  return turnSpendingOf(read.state === "ok" ? read.value : []);
}
