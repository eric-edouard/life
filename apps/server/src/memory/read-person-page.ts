import type { Database } from "bun:sqlite";
import { clock } from "../core/clock";
import { newestDays } from "../core/lists";
import { conversationsWith, speakers, withStore } from "../sources/lifelog";
import { closenessLine } from "./closeness";
import {
  communicationStyleBlock,
  readCommunicationStyle,
} from "./communication-style";
import { detailsBlock, readDetailsOf } from "./details";
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
import { parsePage, slugOf } from "./page-format";
import { openWithOf, reminderItems } from "./read-open-items";
import { goalProjects } from "./read-truth";
import { readSituationNow, situationBlock } from "./situation";
import { clip, normalize } from "./units";
import { meant, namedLike, nearNames, readPeople } from "./who";
import { repliesOwed } from "./words";
import { dayNow, localDate, localTime } from "./zones";

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
        "select substr(l.entity, 8) as id, max(o.at) as at from links l join observations o on o.id = l.observation where l.entity like 'person:%' group by l.entity"
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
  kind: "conversation" | "episode" | "observation";
  line: string;
}

const total = (rows: { n: number }[]) => rows.reduce((a, r) => a + r.n, 0);

/**
 * What Life holds about someone, by source and by month, and what it can't hold, so a short answer never reads as
 * "nothing happened". `timeline`: everything the person's answer pages through.
 */
export function coverageLines(db: Database, ref: string, timeline: Dated[]) {
  const start = db
    .query<{ d: string | null }, []>("select min(date) as d from units")
    .get()?.d;
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
  return [
    `What Life holds about them (its memory starts on ${start ?? "?"}; older chats are only in the archive: \`chats\` with \`who\` and \`from\`):`,
    ...sources.map(
      ([s, rows]) =>
        `- ${s}: ${total(rows)} units, ${rows.map((r) => r.first).sort()[0]} to ${rows
          .map((r) => r.last)
          .sort()
          .at(-1)}`
    ),
    "By month:",
    ...months.map((m) => {
      const here = (byMonth.get(m) ?? []).toSorted((a, b) => b.n - a.n);
      const by = here.map((r) => `${r.source} ${r.n}`).join(", ");
      return `- ${m}: ${total(here)} units${by ? ` (${by})` : ""}, ${count(m, "observation")} observations, ${count(m, "episode")} episodes`;
    }),
    "Not in Life: calls, and time together that wasn't recorded.",
  ];
}

/**
 * A person: their page, whole, and what Life holds about them by source and month; then their observations (every
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
  // What may be open with them besides the observations (someone Life knows, first page only), read before the index
  // opens (nothing awaits while it is).
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
          "join links l on l.observation = o.id where l.entity = ?",
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
      const { next, taken } = newestDays(
        timeline,
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
              ...communicationStyleBlock(
                "Communication style",
                readCommunicationStyle(ref)
              ),
              ...entity(db, found?.text ?? null, obsLines),
              "",
              ...coverageLines(db, ref, timeline),
            ]),
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
      `select count(*) as n from links l join observations o on o.id = l.observation where l.entity = ? and ${CURRENT}`
    )
    .get(`person:${id}`)?.n ?? 0;
