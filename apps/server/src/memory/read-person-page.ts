import type { Database } from "bun:sqlite";
import { clock, HOUR } from "../core/clock";
import { newestDays } from "../core/lists";
import type { History } from "../records/history";
import { conversationsWith, speakers, withStore } from "../sources/lifelog";
import { closenessLine } from "./closeness";
import { notCapturedOf, readCoverage } from "./coverage";
import { detailsBlock, readDetailsOf } from "./details";
import {
  type ExchangeCounts,
  pairCountsOf,
  readExchangeCounts,
} from "./exchange-counts";
import { EXCHANGE_ENDS_AFTER } from "./exchanges";
import { readHistory } from "./histories";
import {
  CURRENT,
  entity,
  episodeLine,
  latest,
  line,
  section,
  withIndex,
} from "./index-rows";
import { daysOf, episodesWhere, pagePath, writtenPeople } from "./ledger";
import { CHANCE, type Chance, MINIMUM, type Thing } from "./move-rates";
import { readMoveRates, type StoredMoveRate } from "./move-rates-file";
import { parsePage, slugOf } from "./page-format";
import { personaBlock, readPersona } from "./personas";
import { openWithOf, reminderItems } from "./read-open-items";
import { goalProjects } from "./read-truth";
import { readSituationNow, situationBlock } from "./situations";
import { clip, normalize } from "./units";
import { meant, namedLike, nearNames, readPeople } from "./who";
import { repliesOwed } from "./words";
import { dayNow, localDate, localTime, monthsOf } from "./zones";

// `bun life memory person [name]` and the connector's `read_person_page`: a person's page, what Life holds about them,
// their observations, episodes and recorded conversations, paged back by day; with no name, the people.

/** One line per person who goes by the name, with relation and observation count; only when more than one does. */
export function candidateLines(
  name: string,
  same: { id: string; name: string; relation?: string }[],
  count: (id: string) => number
) {
  return same.length < 2
    ? []
    : [
        `${same.length} people go by "${name}" (the first below; \`person <id>\` for another):`,
        ...same.map(
          (p) =>
            `- ${p.id}: ${p.name}, ${p.relation ?? "?"}, ${count(p.id)} observations`
        ),
        "",
      ];
}

/** The people who have a page: id and name. */
async function peoplePages() {
  return Promise.all(
    (await writtenPeople()).map(async (ref) => {
      const id = ref.slice("person:".length);
      const page = parsePage(await Bun.file(pagePath(ref)).text());
      return { id, name: page?.meta.name ?? id };
    })
  );
}

/** Who has a page, the latest seen first (the date of the newest observation about them). */
function withPages(db: Database, list: { id: string; name: string }[]) {
  const seen = new Map(
    db
      .query<{ at: string; id: string }, []>(
        "select substr(l.entity, 8) as id, max(o.at) as at from observation_entities l join observations o on o.id = l.observation where l.entity like 'person:%' group by l.entity"
      )
      .all()
      .map((r) => [r.id, r.at])
  );
  return list
    .map((p) => ({ ...p, at: seen.get(p.id) }))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .map(
      (p) =>
        `- ${p.id}: ${p.name}${p.at ? ` (last seen ${localDate(p.at)})` : ""}`
    );
}

/** One thing of a person's timeline: its day, which list it shows in, and its line. */
interface Dated {
  day: string;
  kind: "conversation" | "episode" | "month" | "observation";
  line: string;
}

const total = (rows: { n: number }[]) => rows.reduce((a, r) => a + r.n, 0);

const daysLine = (title: string, by: Map<string, number>) =>
  by.size > 0
    ? `; ${title}: ${[...by].map(([s, n]) => `${s} ${n} day${n === 1 ? "" : "s"}`).join(", ")}`
    : "";

/**
 * What Life holds about someone, by source and by month, and what it can't hold, so a short answer never reads as
 * "nothing happened": each month says the days a source of theirs (one that captures on its own and holds a unit
 * with them) was not captured (`notCapturedOf`). `timeline`: everything the person's answer pages through.
 */
export function heldLines(db: Database, ref: string, timeline: Dated[]) {
  const units = db
    .query<
      { first: string; last: string; m: string; n: number; source: string },
      [string]
    >(
      `select substr(u.date, 1, 7) as m, u.source, count(*) as n, min(u.date) as first, max(u.date) as last
       from unit_people p join units u on u.id = p.unit where p.person = ? group by m, u.source`
    )
    .all(ref);
  const sources = [...Map.groupBy(units, (u) => u.source)].sort(
    (a, b) => total(b[1]) - total(a[1])
  );
  const monthOf = (d: string) => d.slice(0, 7);
  const byMonth = Map.groupBy(units, (u) => u.m);
  const dated = Map.groupBy(timeline, (t) => monthOf(t.day));
  const months = [...new Set([...byMonth.keys(), ...dated.keys()])].sort();
  const count = (m: string, kind: Dated["kind"]) =>
    (dated.get(m) ?? []).filter((t) => t.kind === kind).length;
  const coverage = months[0]
    ? readCoverage(db, `${months[0]}-01`, dayNow())
    : { days: new Map(), sources: [] };
  const theirs = coverage.sources.filter((c) =>
    sources.some(([s]) => s === c.name)
  );
  const missed = notCapturedOf(coverage.days, theirs);
  const since = (s: string) => theirs.find((c) => c.name === s)?.firstDay;
  return [
    "What Life holds about them (older chats are only in the archive: `chats` with `who` and `from`):",
    ...sources.map(
      ([s, rows]) =>
        `- ${s}: ${total(rows)} units, ${rows.map((r) => r.first).sort()[0]} to ${rows
          .map((r) => r.last)
          .sort()
          .at(-1)}${since(s) ? ` (Life holds it since ${since(s)})` : ""}`
    ),
    "By month (not seen, unknown: days a source of theirs was not captured, or Life cannot tell; never quiet days):",
    ...months.map((m) => {
      const here = (byMonth.get(m) ?? []).toSorted((a, b) => b.n - a.n);
      const by = here.map((r) => `${r.source} ${r.n}`).join(", ");
      const gaps = missed.get(m);
      return `- ${m}: ${total(here)} units${by ? ` (${by})` : ""}, ${count(m, "observation")} observations, ${count(m, "episode")} episodes${gaps ? daysLine("not seen", gaps.not_seen) + daysLine("unknown", gaps.unknown) : ""}`;
    }),
    "Not in Life: calls, and time together that wasn't recorded.",
  ];
}

/**
 * A person: their page, whole, with what code counted between them and him (`exchangeCountsBlock`), their history's
 * story and newest months (`historyOf`; the earlier months are paged with the timeline) and what Life holds
 * about them by source and month; then their observations (every
 * one linked to them, whatever page it lives on) and the episodes with them, newest first by whole days, and their
 * recorded conversations. `before` (a day, exclusive) pages back; each answer names the next one. A name
 * two people go by lists them, then shows the first; a name on no page nor map is looked for among lifelog's
 * speakers; a name no one goes by says so and lists the names near it.
 */
export async function person(name?: string, o: { before?: string } = {}) {
  if (!name) {
    const list = await peoplePages();
    return withIndex((db) => {
      const pages = withPages(db, list);
      return pages.length > 0 ? pages : ["(no people pages yet)"];
    });
  }
  const folks = await readPeople();
  const { refOf, truth } = folks;
  const { all: people, known, same } = meant(name, folks);
  // The person's own page, by its id: never one whose file name only holds the name.
  const file = known && Bun.file(pagePath(`person:${known}`));
  const found =
    file && (await file.exists()) ? { text: await file.text() } : null;
  const id = known ?? slugOf(name);
  const ref = `person:${id}`;
  const mapped = truth.people.find((p) => p.id === id);
  const lifelog = mapped?.handles.lifelog;
  const details = detailsBlock(readDetailsOf(folks)(ref), dayNow());
  const close = closenessLine(ref, folks);
  // Pages go by whole local days: a day is never cut between two answers.
  const before = o.before?.slice(0, 10);
  const all = await episodesWhere(() => true);
  const live = new Set(all.map((m) => m.id));
  const episodes = all.filter((m) =>
    m.people.some((p) => refOf(p.ref) === ref)
  );
  // Their history, read before the index opens: its newest months on the first page, the earlier ones in the timeline.
  const history = historyOf(readHistory(ref));
  // What may be open with them besides the observations (someone Life knows, first page only), read before the index
  // opens (nothing awaits while it is).
  // What code counted between them, first page only, read before the index opens too.
  const counted = before || !known ? null : readExchangeCounts();
  const rated = ratesFor(ref, Boolean(before) || !known);
  const more =
    before || !known
      ? []
      : [...reminderItems(), ...(await repliesOwed(clock()))];
  return withStore((store) =>
    withIndex((db) => {
      // A name on no page nor map: the lifelog speakers it is part of.
      const voices = speakers(store);
      const heard = known
        ? []
        : voices.filter((s) => normalize(s.name).includes(normalize(name)));
      if (!(known || heard.length > 0)) {
        return noOne(name, people, voices);
      }
      const ids = lifelog ? [lifelog] : heard.map((s) => s.id);
      // One timeline, newest first, paged once: observations, episodes and recorded conversations.
      const timeline: Dated[] = [
        ...latest(
          db,
          "join observation_entities l on l.observation = o.id where l.entity = ?",
          ref,
          -1
        ).map((r) => ({
          day: r.date,
          kind: "observation" as const,
          line: line(r),
        })),
        ...episodes.toReversed().map((m) => ({
          day: daysOf(m)[0],
          kind: "episode" as const,
          line: episodeLine(m),
        })),
        ...conversationsWith(store, ids).map((c) => ({
          day: localDate(c.start_at),
          kind: "conversation" as const,
          line: `- ${c.id} ${localTime(c.start_at)}: ${clip(c.title, 80)}`,
        })),
      ].toSorted((a, b) => b.day.localeCompare(a.day));
      // The history's months beyond the newest (the first page's block) are paged with the rest, each on its last day.
      const { next, taken } = newestDays(
        [...timeline, ...history.earlier].toSorted((a, b) =>
          b.day.localeCompare(a.day)
        ),
        (t) => t.day,
        PAGE_ITEMS,
        before
      );
      const lines = (kind: Dated["kind"]) =>
        taken.filter((t) => t.kind === kind).map((t) => t.line);
      const obsLines = lines("observation");
      return [
        ...candidateLines(name, same, (who) => linkedCount(db, who)),
        ...(before
          ? [`Before ${before}:`, "Observations:", ...orNone(obsLines)]
          : [
              ...details,
              ...close,
              ...openWithOf(db, ref, {
                goals: goalProjects(truth.me.goals),
                more,
                today: dayNow(),
              }),
              ...situationBlock("Situation", readSituationNow(ref, live)),
              ...personaBlock(readPersona(ref), dayNow()),
              ...exchangeCountsBlock(
                counted && { ...counted, rows: counted.people[ref] ?? [] }
              ),
              ...moveRatesBlock(rated),
              ...history.block,
              ...entity(db, found?.text ?? null, obsLines),
              "",
              ...heldLines(db, ref, timeline),
            ]),
        ...section("Earlier months between them and him:", lines("month")),
        ...section("Episodes with them:", lines("episode")),
        ...section(recordedTitle(heard), lines("conversation")),
        "",
        next
          ? `Older: the same call with \`before\` ${next}.`
          : "(nothing older)",
      ];
    })
  );
}

/** The months of a history the first page shows whole; the earlier ones are paged with the timeline. */
const NEWEST_MONTHS = 12;

/**
 * A person's history (`histories.ts`) as the person read shows it: `block`, the first page's (what it is, the story of
 * the years, the newest months, newest first), and `earlier`, every month before those as a dated entry of the
 * timeline, on its last day. Nothing when no month was read yet.
 */
export function historyOf(history: History) {
  const months = history.months.toReversed();
  const shown = (m: History["months"][number]) => {
    const quotes = m.parts
      .flatMap((p) => p.quotes)
      .map(
        (q) =>
          `"${q.text}" (${localDate(q.at)}, ${q.writer === "owner" ? "him" : "them"})`
      );
    return `- ${m.month}: ${m.parts.map((p) => p.summary).join(" ")}${quotes.length > 0 ? ` Their words: ${quotes.join(", ")}` : ""}`;
  };
  const { story } = history;
  return {
    block:
      months.length > 0
        ? [
            "Past months between them and him (Life's history: each closed month of their one-to-one chats and mail, summarised by a model, quotes checked; not groups, recordings or what was said on calls; earlier months further down and on older pages):",
            ...(story
              ? [`Over the years (through ${story.through}): ${story.text}`]
              : []),
            ...months.slice(0, NEWEST_MONTHS).map(shown),
            "",
          ]
        : [],
    earlier: months.slice(NEWEST_MONTHS).map(
      (m): Dated => ({
        // The month's last day: `monthsOf` ends a month's window there.
        day: monthsOf({ from: `${m.month}-01`, to: `${m.month}-31` })[0]
          ?.to as string,
        kind: "month",
        line: shown(m),
      })
    ),
  };
}

/**
 * What code counts between him and one person (`exchange-counts.ts`): all years, then each year an exchange started
 * in, newest first. Nothing when none was counted (no file yet, or no one-to-one exchange with them): never zeros.
 */
export function exchangeCountsBlock(
  counted: { built: string; rows: ExchangeCounts[]; sources: string[] } | null
) {
  if (!counted || counted.rows.length === 0) {
    return [];
  }
  const answer = (minutes: number | null) =>
    minutes === null ? "none" : `${minutes} min`;
  const counts = (label: string, rows: ExchangeCounts[]) => {
    const c = pairCountsOf(rows);
    return `- ${label}: messages on ${c.days} days; he sent ${c.sent} (${c.sentDeleted} deleted), they sent ${c.got} (${c.gotDeleted} deleted); exchanges opened: he ${c.heOpened}, they ${c.theyOpened}; median answer: he ${answer(c.heAnswersIn)}, they ${answer(c.theyAnswerIn)}`;
  };
  const years = [
    ...Map.groupBy(counted.rows, (r) => localDate(r.start).slice(0, 4)),
  ].sort(([a], [b]) => b.localeCompare(a));
  return [
    `Counted by code between them and him, through ${localDate(counted.built)} (their one-to-one chats and mail threads: ${counted.sources.join(", ")}; not groups nor recordings; a call counts as a message; an exchange lasts until ${EXCHANGE_ENDS_AFTER / HOUR} hours of quiet and is opened by whoever writes first):`,
    counts("all years", counted.rows),
    ...years.map(([year, rows]) => counts(year, rows)),
    "",
  ];
}

/** One person's stored move rates for their page, nothing when it is not the first page or there is no file. */
const ratesFor = (ref: string, skip: boolean) => {
  const file = skip ? null : readMoveRates();
  return (
    file && {
      at: file.at,
      exchanges: file.people[ref]?.exchanges ?? 0,
      rows: file.people[ref]?.rows ?? [],
    }
  );
};

/** A chance in words, after "when" for the rows not proven and as the start of a heading (an exchange chance has its own: per source). */
const WHEN: Record<Exclude<Chance, "exchange">, string> = {
  bid: "of the other's bids",
  decision: "when something is decided",
  fault: "when the other raises a fault",
};
const SECTION_ORDER = ["exchange", "bid", "fault", "decision"];

/**
 * What code counted of how they and he act in their one-to-one chats (`move-rates-file.ts`, from Life's stored
 * reads): per thing the share of its chances, all years, the last 12 months and before, and where it stands among
 * the other people; then, as raw counts only, the few not proven rows kept. Nothing when no file or no row for them.
 */
export function moveRatesBlock(
  rates: { at: string; exchanges: number; rows: StoredMoveRate[] } | null
) {
  if (!rates || rates.rows.length === 0) {
    return [];
  }
  const percent = ({ n, of }: { n: number; of: number }) =>
    of < MINIMUM ? "-" : `${Math.round((100 * n) / of)}%`;
  const figures = (r: StoredMoveRate) =>
    `${percent(r.all)} (${r.all.n}/${r.all.of}; ${percent(r.lately)} | ${percent(r.before)}; ${r.above} of ${r.among} higher)`;
  const chanceOf = (r: StoredMoveRate) => CHANCE[r.thing as Thing];
  const who = (r: StoredMoveRate) => {
    if (!r.side) {
      return "";
    }
    return r.side === "me" ? "he " : "they ";
  };
  // One line per thing (and source), "he" before "they".
  const shown = (
    rows: StoredMoveRate[],
    text: (r: StoredMoveRate) => string,
    label: (r: StoredMoveRate) => string
  ) =>
    [...Map.groupBy(rows, (r) => `${r.thing}|${r.source}`).values()].map(
      (group) =>
        `- ${group[0] ? label(group[0]) : ""}: ${group
          .toSorted((a, b) => (a.side ?? "").localeCompare(b.side ?? ""))
          .map((r) => who(r) + text(r))
          .join(", ")}`
    );
  const sections = [
    ...Map.groupBy(
      rates.rows.filter((r) => r.says === "share"),
      (r) => (chanceOf(r) === "exchange" ? `exchange|${r.source}` : chanceOf(r))
    ),
  ].sort(
    ([a], [b]) =>
      SECTION_ORDER.indexOf(a.split("|")[0] ?? "") -
        SECTION_ORDER.indexOf(b.split("|")[0] ?? "") || a.localeCompare(b)
  );
  const heading = (key: string) => {
    const [chance, source] = key.split("|");
    if (chance === "exchange") {
      return `Per exchange each wrote in, ${source}:`;
    }
    const when = WHEN[chance as keyof typeof WHEN];
    return `${when.charAt(0).toUpperCase()}${when.slice(1)}:`;
  };
  const guessed = rates.rows.filter((r) => r.says === "exploratory");
  return [
    `## Counted from their one-to-one chats (Life's reads, built ${localDate(rates.at)}; ${rates.exchanges} exchanges read)`,
    "Each line: share of chances (n/of) all years; last 12 months | before; N of M other people are higher.",
    "Legend: toward = took up the other's bid; warm = the exchange read warm on that side; tension, conflict = the exchange held some.",
    ...sections.flatMap(([key, rows]) => [
      heading(key),
      ...shown(rows, figures, (r) => r.thing),
    ]),
    ...(guessed.length > 0
      ? [
          "Counted, not proven (raw counts only: two models agree too little on these, or the test had too few cases):",
          ...shown(
            guessed,
            (r) => `${r.all.n}/${r.all.of}`,
            (r) =>
              `${r.thing} (${chanceOf(r) === "exchange" ? `per exchange, ${r.source}` : WHEN[chanceOf(r) as keyof typeof WHEN]})`
          ),
        ]
      : []),
    "",
  ];
}

/** `heard`: the lifelog speakers a name on no page nor map was found among. */
const recordedTitle = (heard: { name: string }[]) =>
  `Recorded conversations${heard.length > 0 ? ` with lifelog speakers named ${[...new Set(heard.map((s) => s.name))].join(", ")}` : ""} (\`fetch <id>\`):`;

/** How many things of a person's timeline an answer shows, its last day taken whole. */
const PAGE_ITEMS = 24;

const orNone = (lines: string[]) => (lines.length > 0 ? lines : ["(none)"]);

/** A name no one goes by: says so, with the names near it (lifelog's speakers too, but one already on the list is that person). */
function noOne(
  name: string,
  people: { aliases: string[]; id: string; name: string }[],
  heard: { name: string }[]
) {
  const near = nearNames(name, [
    ...people,
    ...heard
      .filter((s) => namedLike(s.name, people).length === 0)
      .map((s) => ({ aliases: [], id: s.name, name: s.name })),
  ]);
  return [
    `No one goes by "${name}".`,
    ...(near.length > 0
      ? [
          "Names near it (`person <id>`):",
          ...near.map((p) => `- ${p.id}: ${p.name}`),
        ]
      : []),
  ];
}

const linkedCount = (db: Database, id: string) =>
  db
    .query<{ n: number }, [string]>(
      `select count(*) as n from observation_entities l join observations o on o.id = l.observation where l.entity = ? and ${CURRENT}`
    )
    .get(`person:${id}`)?.n ?? 0;
