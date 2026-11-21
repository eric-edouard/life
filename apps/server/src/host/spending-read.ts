import type { Database } from "bun:sqlite";
import { clock, daysBefore } from "../core/clock";
import { matterFinderOf } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import {
  type Basis,
  providerOfRuntime,
  type SpendKind,
  type SpendProvider,
  spendOfTurn,
  type TurnSpent,
} from "../memory/spends";
import { readPeople } from "../memory/who";
import { dayNow, dayRange } from "../memory/zones";
import { anchorsOf, assignmentOf, type DeskRead, readDesk } from "./desk-read";
import { sessionTurnsOf, stepTurnsOf, turnsEndedIn } from "./desk-turn-reads";
import type { RegisteredAgents } from "./registered-agents";
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

/** A local day's spending: its file, else read live from its records (today, or a closed day the night has not rolled up). A live read that fails throws: never a day shown as $0. */
async function dayOf(
  day: string,
  isLive: boolean
): Promise<DaySpending | undefined> {
  const kept = readSpendingDay(day);
  if (kept || !isLive) {
    return kept;
  }
  const { spends, unsettled } = await readDaySpends(day);
  return { ...spendingOf(spends), day, unsettled };
}

/** The desk's history, read even while the desk is off; unreadable throws (never zero tokens). */
function deskValueOf<T>(read: DeskRead<T>, empty: T) {
  if (read.state === "unreadable") {
    throw new Error(`desk: ${read.why}`);
  }
  return read.state === "ok" ? read.value : empty;
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

/** Turns as `{tokens, equivalent, reported}`: `reported` false when one has no price or usage (its equivalent a floor). */
const turnSpendingOf = (turns: TurnSpent[]) => {
  const spends = turns.map(spendOfTurn);
  return {
    equivalent: amountOf(
      spends.reduce((n, s) => n + (s.equivalentUsd ?? 0), 0),
      "equivalent"
    ),
    reported: spends.every((s) => s.reported),
    tokens: spends.reduce(
      (n, s) => n + (s.tokens ? s.tokens.input + s.tokens.output : 0),
      0
    ),
  };
};

/** Turns grouped by `keyOf`, ranked by tokens, the first `TOP`. */
function topOf(
  turns: TurnSpent[],
  keyOf: (t: TurnSpent) => string | undefined
) {
  const by = new Map<string, TurnSpent[]>();
  for (const t of turns) {
    const key = keyOf(t);
    if (key) {
      const list = by.get(key);
      if (list) {
        list.push(t);
      } else {
        by.set(key, [t]);
      }
    }
  }
  return [...by]
    .map(([id, list]) => ({ id, ...turnSpendingOf(list) }))
    .toSorted((a, b) => b.tokens - a.tokens)
    .slice(0, TOP);
}

type Finder = (
  refs: readonly string[],
  prefer?: string
) => { id: string; name: string } | undefined;

/** What finds an assignment's matter: its anchors, and the matter he chose for it on a tie (`assignment.matter_id`). */
interface Chosen {
  prefer?: string;
  steps: string[];
}
const chosenOf = (db: Database, id: string): Chosen => ({
  prefer: assignmentOf(db, id)?.matter_id ?? undefined,
  steps: anchorsOf(db, id),
});

/**
 * The month's agents and matters by their turns' tokens, by id, named last: an agent by its name (else its id), a
 * matter by its assignment's anchors (`matterFinderOf`, the one rule `tokenRowsOf` and `read_matter` follow). The book
 * is read only when an assignment has anchors.
 */
async function readTops(from: string, to: string) {
  const { anchors, names, turns } = deskValueOf(
    readDesk(
      (db) => {
        const ended = turnsEndedIn(db, from, to);
        const ids = [...new Set(ended.map((t) => t.agent_id))];
        return {
          anchors: [...new Set(ended.map((t) => t.assignment_id))].map(
            (id) => [id, chosenOf(db, id)] as const
          ),
          names:
            ids.length === 0
              ? []
              : db
                  .query<{ id: string; name: string | null }, string[]>(
                    `select id, name from agent where id in (${ids.map(() => "?").join(",")})`
                  )
                  .all(...ids),
          turns: ended,
        };
      },
      { anchors: [], names: [], turns: [] },
      true
    ),
    { anchors: [], names: [], turns: [] }
  );
  const nameOf = new Map(names.map((a) => [a.id, a.name ?? a.id]));
  const anchored = anchors.filter(([, c]) => c.steps.length > 0);
  const find: Finder =
    anchored.length > 0
      ? matterFinderOf(await readMatterBook(await readPeople(), dayNow()))
      : () => undefined;
  const matterOf = new Map(
    anchored.flatMap(([asg, c]) => {
      const m = find(c.steps, c.prefer);
      return m ? [[asg, m] as const] : [];
    })
  );
  return {
    topAgents: topOf(turns, (t) => t.agent_id).map((t) => ({
      agent: nameOf.get(t.id) ?? t.id,
      ...t,
    })),
    topMatters: topOf(turns, (t) => matterOf.get(t.assignment_id)?.id).map(
      (t) => ({
        matter: [...matterOf.values()].find((m) => m.id === t.id)?.name ?? t.id,
        ...t,
      })
    ),
  };
}

/** `read_spending`: his month (default the current one), each day held, today always; billed and equivalent apart. A read that fails throws. */
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
    // The agents run on his plans: their kind is shown in tokens and their list price, never a billed $0.
    byKind: kinds.map((k) => ({
      ...(k.kind === "agents"
        ? { equivalent: amountOf(k.equivalentUsd, "equivalent") }
        : { billed: amountOf(k.billedUsd, "billed") }),
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
    // Voice work not settled when its day was written (or now, today): not counted, so the month is a floor.
    unsettled: held.reduce((n, d) => n + d.unsettled, 0),
    ...(await readTops(from, to)),
  };
}

/** `read_registered_agents` with each agent's `spending` in its current session (since, tokens, equivalent, reported, provider); none when the desk can't be read. */
export function withAgentSpending(read: RegisteredAgents) {
  const desk = readDesk(
    (db) =>
      sessionTurnsOf(
        db,
        read.agents.map((a) => a.id)
      ),
    { sessions: [], turns: [] },
    true
  );
  if (desk.state !== "ok") {
    return { ...read };
  }
  const { sessions, turns } = desk.value;
  return {
    ...read,
    agents: read.agents.map((a) => ({
      ...a,
      spending: {
        ...turnSpendingOf(turns.filter((t) => t.agent_id === a.id)),
        provider: providerOfRuntime(a.runtime),
        since: sessions.find((s) => s.agent_id === a.id)?.started_at ?? null,
      },
    })),
  };
}

/** The turns of `id`'s matter: those whose assignment's anchors `find` names it, his chosen matter first on a tie (the one rule), each assignment looked up once. Pure. */
export function matterTurnsOf(
  turns: TurnSpent[],
  chosenOfAssignment: (id: string) => Chosen,
  find: Finder,
  id: string
) {
  const isHers = new Map<string, boolean>();
  return turns.filter((t) => {
    const known = isHers.get(t.assignment_id);
    if (known !== undefined) {
      return known;
    }
    const c = chosenOfAssignment(t.assignment_id);
    const is = find(c.steps, c.prefer)?.id === id;
    isHers.set(t.assignment_id, is);
    return is;
  });
}

/** A matter's spending (`read_matter`): its assignments' turns (`matterTurnsOf`), read even while the desk is off; none when the desk can't be read. */
export function readMatterSpending(find: Finder, id: string, steps: string[]) {
  const desk = readDesk(
    (db) =>
      matterTurnsOf(stepTurnsOf(db, steps), (a) => chosenOf(db, a), find, id),
    [],
    true
  );
  return desk.state === "ok" ? turnSpendingOf(desk.value) : undefined;
}
