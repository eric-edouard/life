import type { Database } from "bun:sqlite";
import { clock, daysBefore } from "../core/clock";
import { type Call, isReviewCall, recentEvents } from "../core/log";
import { Level } from "../records/observation";
import { TOP_AT } from "../records/unit";
import { openLinked } from "../todo-list/linked";
import { levelsWith } from "./closeness";
import { COLUMNS, CURRENT, line, type Row, section } from "./index-rows";
import { readLedger } from "./ledger";
import {
  AGAIN_DAYS,
  type Candidate,
  isOwedToHim,
  type OpenItem,
  OVERDUE_DAYS,
  openItems,
  rankedItems,
} from "./open-items";
import { goalProjects, OWNER } from "./read-truth";
import type { People } from "./who";
import { repliesOwed } from "./words";
import { dayNow, dayStart, localDate } from "./zones";

// The open items the read path shows, read from the index, the ledger and the chats: what `read_day` lists as due and
// what a person's page lists as open with them. `open-items.ts` merges, times and ranks them.

/**
 * What `read_day` lists as due on `date` (`openItems`, apps/server/src/memory/open-items.ts, which merges, times and ranks): the importance-3 promises
 * and waiting items, and the to-dos he said (not a mail's), dated up to `OVERDUE_DAYS` before; his reminders in the
 * ledger; the replies he owes. Who said each, when not him, is labelled.
 */
export function dueOf(
  db: Database,
  date: string,
  { more, ...context }: Awaited<ReturnType<typeof dueContext>>
) {
  const said = openCandidatesOf(
    db,
    `(o."when" between ? and ? or (o."when" is null and o.date between ? and ?))`,
    daysBefore(date, OVERDUE_DAYS),
    date,
    daysBefore(date, AGAIN_DAYS),
    date
  );
  return openItems([...said, ...more], { ...context, date }).map(itemLine);
}

/**
 * The importance-3 current promises and waiting items, and the to-dos he said (not a mail's), that `narrow` (over
 * `o`, with `params`) keeps, as open items with their lines.
 */
export function openCandidatesOf(
  db: Database,
  narrow: string,
  ...params: string[]
) {
  const rows = db
    .query<
      Row & {
        at: string;
        projects: string | null;
        whom: string | null;
      },
      string[]
    >(
      `select ${COLUMNS}, o.at,
         (select group_concat(substr(entity, 9)) from observation_entities where observation = o.id and entity like 'project:%') as projects,
         (select entity from observation_entities where observation = o.id and entity like 'person:%' and entity != ? order by entity limit 1) as whom
       from observations o where o.importance = ${TOP_AT} and ${CURRENT}
       and (o.type in ('promise', 'waiting_on_someone') or (o.type = 'to_do' and o.speaker = ?))
       and ${narrow} order by o.at, o.id`
    )
    .all(OWNER, OWNER, ...params);
  return rows.map(
    (r): Candidate => ({
      at: r.at,
      id: r.id,
      kind: r.type as Candidate["kind"],
      line: line(r),
      // Whoever it is with: the speaker when not him, else the first person it names.
      person:
        r.speaker && r.speaker !== OWNER ? r.speaker : (r.whom ?? undefined),
      projects: r.projects?.split(",") ?? [],
      said: r.when ? undefined : r.date,
      when: r.when ?? undefined,
    })
  );
}

const itemLine = (i: OpenItem) =>
  `${i.line}${i.overdue ? " (overdue)" : ""}${i.merged.length > 0 ? ` (also ${i.merged.join(", ")})` : ""}`;

/**
 * What is open between him and `ref`, every item ranked (`rankedItems`), as the person page's section: what he owes
 * them, then what he waits on (`isOwedToHim`). Theirs are the observations linked to them, the replies he owes them
 * and the reminders made from one of those (`more`: replies owed and reminders, every one).
 */
export function openWithOf(
  db: Database,
  ref: string,
  {
    goals,
    more,
    today,
  }: { goals: string[][]; more: Candidate[]; today: string }
) {
  const said = openCandidatesOf(
    db,
    "exists (select 1 from observation_entities where observation = o.id and entity = ?)",
    ref
  );
  const ids = new Set(said.map((c) => c.id));
  const items = rankedItems(
    [
      ...said,
      ...more.filter((c) => c.person === ref || (c.obs && ids.has(c.obs))),
    ],
    { date: today, goals }
  );
  const owedToHim = items.filter(isOwedToHim);
  const his = items.filter((i) => !isOwedToHim(i));
  return items.length > 0
    ? [
        "",
        "Open with them (done when Life sees it done or he says so):",
        ...section("He owes them:", his.map(itemLine)),
        ...section("He waits on:", owedToHim.map(itemLine)),
      ]
    : [];
}

/** His open reminders in the ledger (`openLinked`), as open items: one made from an observation merges into it. */
export const reminderItems = (): Candidate[] =>
  openLinked(readLedger()).map(({ at, fields: f, key, ref }) => ({
    at,
    id: key,
    kind: "reminder",
    line: `- ${key} reminder: "${f.title}"${f.due ? ` (for ${f.due})` : ""}${f.list ? ` in ${f.list}` : ""}`,
    obs: ref?.startsWith("obs_") ? ref : undefined,
    priority: (f.priority as string | null) ?? undefined,
    urgent: Boolean(f.urgent || f.flagged),
    when: f.due ? `${f.due}`.slice(0, 10) : undefined,
  }));

/** What `dueOf` needs besides the index, read before it opens (nothing awaits while the index is open). */
export async function dueContext(date: string, people: People) {
  const { truth } = people;
  // His present gates which days have come; `end` and the said days are recorded days (history).
  const today = dayNow();
  const end = Math.min(
    clock().getTime(),
    dayStart(daysBefore(date, -1)).getTime()
  );
  const levels = new Map(
    [...levelsWith(people)].map(([p, l]) => [
      p,
      Math.min(
        Level.options.indexOf(l.personal),
        Level.options.indexOf(l.work)
      ),
    ])
  );
  return {
    goals: goalProjects(truth.me.goals),
    levels,
    more: [...reminderItems(), ...(await repliesOwed(new Date(end)))],
    shown: await shownDays(date),
    today,
  };
}

/** The days before `date` on which the agent's daily review got each id from `read_day` (the logged `mcp.call` ids). */
async function shownDays(date: string) {
  const days = new Map<string, Set<string>>();
  const calls = await recentEvents<Call>(OVERDUE_DAYS + 2, "mcp.call");
  for (const c of calls) {
    const on = localDate(c.at);
    if (isReviewCall(c) && on < date) {
      for (const id of c.ids ?? []) {
        days.set(id, (days.get(id) ?? new Set()).add(on));
      }
    }
  }
  return new Map([...days].map(([id, d]) => [id, [...d]]));
}
