import { clock, daysBefore } from "../core/clock";
import { within } from "../core/lists";
import { type Call, isReviewCall, recentEvents } from "../core/log";
import { ClosenessLevel } from "../records/observation";
import { levelsWith } from "./closeness";
import { QUOTE_MAX, section } from "./index-rows";
import {
  doneOnOf,
  type MatterStepNow,
  type MatterView,
  matterPeopleOf,
} from "./matter-read";
import { readMatterBook } from "./matters";
import {
  type Candidate,
  isOwedToHim,
  type OpenItem,
  OVERDUE_DAYS,
  openItems,
  rankedItems,
} from "./open-items";
import { goalProjects } from "./read-truth";
import { oneLineOf } from "./units";
import type { People } from "./who";
import { repliesOwed } from "./words";
import { dayNow, dayStart, localDate } from "./zones";

// The open items the read path shows, read from the matters and the chats: what `read_day` lists as due and what a
// person's page lists as open with them. `open-items.ts` times and ranks them.

/** How a step ended, in words, with its day: none while open. */
const endingWords = ({ ending: e }: Pick<MatterStepNow, "ending">) => {
  if (!e) {
    return "";
  }
  const on = localDate(e.at);
  if (e.by === "link") {
    return ` (probably ended ${on}: "${oneLineOf(e.quote, QUOTE_MAX)}")`;
  }
  if (e.by === "ticked") {
    return ` (ticked ${on})`;
  }
  return e.replacedBy
    ? ` (ended ${on}: replaced by ${e.replacedBy})`
    : ` (ended ${on}: "${oneLineOf(e.why, QUOTE_MAX)}")`;
};

/** An open matter as `read_day` and a person's page list it: its newest open step, who it is with, where it stands. */
function lineOf(v: MatterView, nameOf: (ref: string) => string) {
  const next = v.newestOpenStep as MatterStepNow;
  const who = (label: string, refs: string[]) =>
    refs.length > 0 ? `; ${label} ${refs.map(nameOf).join(", ")}` : "";
  return `- ${v.id} ${next.day} ${next.kind}: ${next.text}${next.when ? ` (for ${next.when})` : ""} (${v.name}; ${v.status}${who("owed to", v.owedTo)}${who("waiting on", v.waitingOn)}) "${oneLineOf(next.quote, QUOTE_MAX)}" (${next.ref})`;
}

/**
 * The open matters as open items (`matterOf`: one rule of what is open), one each, by its newest open step: due on
 * its earliest open date not more than `OVERDUE_DAYS` before `date`, else said on the day of that step. Who it is with is the step's person, else who it is owed to,
 * waited on, or with.
 */
export const matterItems = (
  book: MatterView[],
  nameOf: (ref: string) => string,
  date: string
): Candidate[] =>
  book.flatMap((v): Candidate[] => {
    const next = v.newestOpenStep;
    // An open step: a to-do, promise, wait or to-do item.
    if (!(v.open && next)) {
      return [];
    }
    const open = v.openSteps;
    const since = daysBefore(date, OVERDUE_DAYS);
    const dates = open.flatMap((s) => (s.when ? [s.when] : [])).toSorted();
    // A date too old to list stays its date (never said again as undated).
    const due = dates.find((d) => d >= since) ?? dates.at(0);
    const people = matterPeopleOf(v);
    return [
      {
        at: next.at,
        id: v.id,
        kind: next.kind as Candidate["kind"],
        line: lineOf(v, nameOf),
        people,
        person: next.with ?? people[0],
        priority: open.find((s) => s.priority)?.priority,
        projects: v.projects,
        said: due ? undefined : next.day,
        urgent: open.some((s) => s.urgent),
        when: due,
      },
    ];
  });

const itemLine = (i: OpenItem) => `${i.line}${i.overdue ? " (overdue)" : ""}`;

/**
 * What `read_day` lists as due on `date` (`openItems`, apps/server/src/memory/open-items.ts, which times and ranks):
 * the open matters (`matterItems`) and the replies he owes, due by their dates.
 */
export function dueOf(
  date: string,
  { items, ...context }: Awaited<ReturnType<typeof dueContext>>
) {
  return openItems(items, { ...context, date }).map(itemLine);
}

/**
 * What is open between him and `ref`, every item ranked (`rankedItems`), as the person page's section: what he owes
 * them, then what he waits on (`isOwedToHim`). Theirs are the open matters they are in, whatever their role, and the
 * replies he owes them (`items`). `room`: about how many characters the lines may take, the top-ranked first; what
 * does not fit is counted and left to `read_matters`.
 */
export function openWithOf(
  ref: string,
  {
    goals,
    items: all,
    owner,
    room = Number.POSITIVE_INFINITY,
    today,
  }: {
    goals: string[][];
    items: Candidate[];
    /** His name (`readOwnerName`). */
    owner: string;
    room?: number;
    today: string;
  }
) {
  const items = rankedItems(
    all.filter((c) => c.person === ref || c.people?.includes(ref)),
    { date: today, goals }
  );
  // One cut over the ranked items, then the two sections of what fits: the top-ranked always come first.
  const fits = within(items, room, (i) => itemLine(i).length + 1);
  const his = fits.filter((i) => !isOwedToHim(i)).map(itemLine);
  const waits = fits.filter(isOwedToHim).map(itemLine);
  const more = items.length - fits.length;
  return items.length > 0
    ? [
        "",
        `Open with them (done when Life sees it done or ${owner} says so):`,
        ...section(`${owner} owes them:`, his),
        ...section(`${owner} waits on:`, waits),
        ...(more > 0
          ? [
              `${more} more open with them, ranked lower: \`read_matters\` with person ${ref.slice(ref.indexOf(":") + 1)}.`,
            ]
          : []),
      ]
    : [];
}

/** Every open matter on `today` (`book`, `readMatterBook` when not given), with the replies he owes up to `end`. */
export async function readOpenItems(
  people: People,
  end: Date,
  date = dayNow(),
  book?: MatterView[]
) {
  return [
    ...matterItems(
      book ?? (await readMatterBook(people, dayNow())),
      people.nameOf,
      date
    ),
    ...(await repliesOwed(end)),
  ];
}

/** The matters that ended on `date` (`doneOnOf`): each with its name and how its last step ended. */
export const doneOf = (book: readonly MatterView[], date: string) =>
  doneOnOf(book, date, localDate).map(({ last, matter }) => ({
    how: `${last.text}${endingWords(last)}`,
    matter,
  }));

/** `doneOf` as `read_day` lines, each with the matter's id and status. */
const doneLinesOf = (book: readonly MatterView[], date: string) =>
  doneOf(book, date).map(
    ({ how, matter: m }) => `- ${m.id} ${m.name} [${m.status}]: ${how}`
  );

/** What the rank reads besides the items (`rankedItems`): his goals' projects in order, and each person's closeness, inner first. */
export const rankContextOf = (people: People) => ({
  goals: goalProjects(people.truth.me.goals),
  levels: new Map(
    [...levelsWith(people)].map(([p, l]) => [
      p,
      Math.min(
        ClosenessLevel.options.indexOf(l.personal),
        ClosenessLevel.options.indexOf(l.work)
      ),
    ])
  ),
});

/**
 * The running matters in the order the rank gives their open step (`matterItems`, `rankedItems`: his urgent flag and
 * priority, kind, his goals, closeness, then age), those with no open step after them, newest first.
 */
export function rankedMattersOf(
  book: MatterView[],
  nameOf: (ref: string) => string,
  today: string,
  context: ReturnType<typeof rankContextOf>
) {
  const rank = new Map(
    rankedItems(matterItems(book, nameOf, today), {
      date: today,
      ...context,
    }).map((item, i) => [item.id, i])
  );
  const newest = (v: MatterView) => v.steps.at(-1)?.at ?? "";
  return book.toSorted(
    (a, b) =>
      (rank.get(a.id) ?? book.length) - (rank.get(b.id) ?? book.length) ||
      newest(b).localeCompare(newest(a))
  );
}

/** What `dueOf` needs besides the index, read before it opens (nothing awaits while the index is open). */
export async function dueContext(date: string, people: People) {
  // His present gates which days have come; `end` and the said days are recorded days (history).
  const today = dayNow();
  const end = Math.min(
    clock().getTime(),
    dayStart(daysBefore(date, -1)).getTime()
  );
  const book = await readMatterBook(people, today);
  return {
    ...rankContextOf(people),
    done: doneLinesOf(book, date),
    items: await readOpenItems(people, new Date(end), date, book),
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
