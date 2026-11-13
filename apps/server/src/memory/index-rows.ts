import type { Database } from "bun:sqlite";
import type { SourceName } from "../core/names";
import { redact } from "../core/redact";
import type { Episode } from "../records/episode";
import { KEEP_AT } from "../records/unit";
import { episodeText } from "./doubts";
import { readIndex } from "./memory-files";
import { bodyOf, generated, parsePage, renderLine } from "./page-format";
import { SURE_AT } from "./quote-check";
import { OWNER } from "./read-truth";
import { kindOf } from "./sources";
import { clip } from "./units";
import { who as named } from "./who";
import { asData } from "./words";

// The index's rows as the read path prints them (derived/memory/index.sqlite, written by index-writer.ts): an
// observation's line, a unit's, an episode's, a page with its observations, and the read under the usual heading.
// Reading only.

export const LIMIT = 12;

/** An episode's text, each person by their ref: what the read path prints and both rankings read. */
export const episodeTextNow = (m: Episode) =>
  episodeText(m, (ref) => named({ speaker: ref }));

/** An episode as the read path prints it: its id (to correct it), `episodeText`, and units to `fetch`. */
export const episodeLine = (m: Episode) =>
  `- ${m.id} ${episodeTextNow(m)}${m.start ? "" : ` (${m.day}, undated)`} [${m.units.slice(0, 3).join(" ")}]`;

const QUOTE_MAX = 140;
const TITLE_MAX = 50;

export interface Row {
  channel: SourceName;
  confidence: number;
  date: string;
  id: string;
  people: string | null;
  quote: string;
  speaker: string | null;
  text: string;
  title: string | null;
  type: string;
  when: string | null;
}

/** Who said it, when not him: "by" a sender (exact), "heard as" a voice (lifelog names one wrongly about 5% of the time). Labelled, never filtered. */
const byOf = ({ channel, speaker }: Row) =>
  !speaker || speaker === OWNER
    ? ""
    : ` ${kindOf(channel) === "voice" ? "heard as" : "by"} ${named({ speaker })}`;

/** An observation hit, with its date if it carries one, who said it when not him, a doubt, and where it comes from: `(channel "unit title"; people ids)`. */
export const line = (r: Row) => {
  const q = r.quote.replace(/\s+/g, " ");
  const from = `${r.channel} "${clip(r.title ?? "", TITLE_MAX)}"${r.people ? `; ${r.people}` : ""}`;
  const about = `${r.when ? ` (for ${r.when})` : ""}${byOf(r)}${r.confidence < SURE_AT ? " (unsure)" : ""}`;
  return `- ${r.id} ${r.date} ${r.type}: ${r.text}${about} "${q.length > QUOTE_MAX ? `${q.slice(0, QUOTE_MAX)}…` : q}" (${from})`;
};

export interface UnitRow {
  date: string;
  id: string;
  /** Its verdict's, or null when it has none yet. */
  importance?: number | null;
  source: SourceName;
  title: string;
  topics: string;
}

export const unitLine = (u: UnitRow) =>
  `- ${u.id} ${u.date} ${u.source}: ${clip(u.title, 80)}${u.topics ? ` [${u.topics}]` : ""}`;

export const COLUMNS = `o.id, o.date, o.type, o.text, o.quote, o.channel, o.confidence, o."when", o.speaker,
  (select title from units where id = o.unit) as title,
  (select group_concat(replace(replace(person, 'person:', ''), 'unknown:', ''), ', ') from unit_people where unit = o.unit) as people`;
export const CURRENT = "o.superseded_by is null";

/** An observation's and a unit's text, as both rankings read them (`unit_search` holds a unit's). */
export const OBSERVATION_TEXT = "o.text || char(10) || o.quote";
export const UNIT_TEXT =
  "coalesce(s.title, '') || char(10) || coalesce(s.summary, '') || char(10) || coalesce(s.topics, '')";

/** The observations `clause` finds worth a page line, newest first: `limit` of them (-1: all). */
export function latest(
  db: Database,
  clause: string,
  value: string,
  limit = LIMIT
) {
  return db
    .query<Row, [string]>(
      `select ${COLUMNS} from observations o ${clause} and o.importance >= ${KEEP_AT} and ${CURRENT}
       order by o.date desc, o.at desc limit ${limit}`
    )
    .all(value);
}

const NOT_BUILT =
  "Life's memory index isn't built yet (bun life memory index).";

/** `lines` from the index under the usual heading; says so when it isn't built. */
export function withIndex(lines: (db: Database) => string[]) {
  const out = readIndex(lines);
  return out === null ? NOT_BUILT : asData(out);
}

/** The page's text, each Between us line followed by the days of its first and latest evidence. */
export function withSpans(text: string, dateOf: (id: string) => string[]) {
  const parsed = parsePage(text);
  let body = bodyOf(text);
  for (const l of parsed ? generated(parsed).bond : []) {
    const days = l.cites.flatMap(dateOf).toSorted();
    const rendered = renderLine("bond", l);
    // A function, so a `$` in the line is never read as a replacement pattern.
    body = body.replace(rendered, () =>
      days.length > 0
        ? `${rendered} (since ${days[0]} · last evidence ${days.at(-1)})`
        : rendered
    );
  }
  return body;
}

/** A page, whole, with when it was built, when it has one; then the observations found for it. */
export function entity(db: Database, text: string | null, found: string[]) {
  const meta = text ? parsePage(text)?.meta : undefined;
  const dates = db.query<{ date: string }, [string]>(
    "select date from observations where id = ?"
  );
  return [
    ...(text && meta
      ? [
          `(page built ${meta.built.slice(0, 16).replace("T", " ")} UTC: newer observations are below, not on it yet)`,
          redact(withSpans(text, (id) => dates.all(id).map((r) => r.date))),
          "",
        ]
      : []),
    "Latest observations:",
    ...(found.length > 0 ? found : ["(none)"]),
  ];
}

export const section = (title: string, lines: string[]) =>
  lines.length > 0 ? ["", title, ...lines] : [];
