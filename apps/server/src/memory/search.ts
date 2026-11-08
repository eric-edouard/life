import type { Database } from "bun:sqlite";
import { CANDIDATES } from "../core/embedder";
import { fuse } from "../core/fusion";
import { redact } from "../core/redact";
import { searchVoice, turnPlace, withStore } from "../sources/lifelog";
import {
  COLUMNS,
  CURRENT,
  episodeLine,
  episodeTextNow,
  LIMIT,
  line,
  OBSERVATION_TEXT,
  type Row,
  UNIT_TEXT,
  type UnitRow,
  unitLine,
  withIndex,
} from "./index-rows";
import { episodesWhere } from "./ledger";
import { OWNER } from "./read-truth";
import { readSituationNow, situated, situationBlock } from "./situation";
import { listening } from "./sources";
import { normalize } from "./units";
import { embedQuery, readNearest } from "./vectors";
import { readPeople } from "./who";
import { chatHits, focus, holdsAll, MAIL_HITS, mailHits } from "./words";
import { type DayRange, dayRange, inDays, localTime } from "./zones";

// `bun life memory search <words>` and the connector's `search`: episodes, observations and units matching the words
// (from derived/memory/index.sqlite), the exact spoken words (lifelog's search), chats and mail, each ranked by meaning
// and by words, fused (`fuse`), opening with the situations they bear on.

/** A section's first LIMIT lines (its last, `newest`), saying so when there were more. */
const cut = (lines: string[], newest = false) =>
  lines.length > LIMIT
    ? [
        ...(newest ? lines.slice(-LIMIT) : lines.slice(0, LIMIT)),
        `(cut at ${LIMIT}: narrow with \`from\` and \`to\`)`,
      ]
    : lines;

const VOICE_LIMIT = 20;
const VOICE_MAX = 300;

const WORD = /[\p{L}\p{N}]+/gu;

/** Every word quoted, so FTS5 reads them as words, never as its query syntax. */
const ftsQuery = (q: string, op: "AND" | "OR") =>
  (q.match(WORD) ?? []).map((w) => `"${w}"`).join(` ${op} `);

/** The local days `from` to `to` (both included, either open) as a SQL condition on `col`, with its values. */
const between = (col: string, r: DayRange) => ({
  args: [r.from, r.to]
    .filter((d): d is string => !!d)
    .map((d) => d.slice(0, 10)),
  sql: `${r.from ? ` and ${col} >= ?` : ""}${r.to ? ` and ${col} <= ?` : ""}`,
});

/** Rows of `sql` (taking the ids as JSON) for `ids`, in their order. */
function rowsFor<R extends { id: string }>(
  db: Database,
  sql: string,
  ids: string[]
) {
  const byId = new Map(
    db
      .query<R, [string]>(sql)
      .all(JSON.stringify(ids))
      .map((r) => [r.id, r])
  );
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** The observations and units best for `q` by meaning (`vector`) and by words (holding them all), fused (`fuse`). */
export function matches(
  db: Database,
  q: string,
  range: DayRange = {},
  vector?: number[]
) {
  const o = between("o.date", range);
  const u = between("u.date", range);
  const query = ftsQuery(q, "AND");
  const held = (sql: string, args: string[]) =>
    query
      ? db
          .query<{ id: string }, string[]>(sql)
          .all(query, ...args)
          .map((r) => r.id)
      : [];
  const best = (rankings: string[][]) =>
    fuse(rankings)
      .slice(0, LIMIT + 1)
      .map(([id]) => id);
  const texts = (sql: string, args: string[]) => () =>
    db.query<{ id: string; text: string }, string[]>(sql).all(...args);
  const observations = rowsFor<Row>(
    db,
    `select ${COLUMNS} from observations o where o.id in (select value from json_each(?))`,
    best([
      readNearest(
        vector,
        texts(
          `select o.id, ${OBSERVATION_TEXT} as text from observations o where ${CURRENT}${o.sql}`,
          o.args
        )
      ),
      held(
        `select o.id from search s join observations o on o.id = s.id
          where search match ? and ${CURRENT}${o.sql} order by rank limit ${CANDIDATES}`,
        o.args
      ),
    ])
  ).map(line);
  const units = rowsFor<UnitRow>(
    db,
    "select id, date, source, title, topics from units where id in (select value from json_each(?))",
    best([
      readNearest(
        vector,
        texts(
          `select s.id, ${UNIT_TEXT} as text from unit_search s join units u on u.id = s.id where 1${u.sql}`,
          u.args
        )
      ),
      held(
        `select u.id from unit_search s join units u on u.id = s.id
          where unit_search match ?${u.sql} order by rank limit ${CANDIDATES}`,
        u.args
      ),
    ])
  ).map(unitLine);
  if (observations.length + units.length === 0) {
    return ["(nothing found)"];
  }
  return [
    ...cut(observations),
    ...(units.length > 0
      ? ["", "Units (titles, summaries, topics):", ...cut(units)]
      : []),
  ];
}

/** The voice section of `search`: lifelog's best passages for the words, each with its place in its conversation. */
async function voiceHits(words: string, range: DayRange) {
  if (!listening()) {
    return ["(no voice source)"];
  }
  try {
    const hits = await searchVoice(words, range, VOICE_LIMIT);
    return withStore((store) =>
      hits.length > 0
        ? hits.map((h) => {
            const at = h.capturedFrom ? `${localTime(h.capturedFrom)}` : "?";
            const p = turnPlace(store, h.jobId, h.firstTurn);
            return `- ${p?.conversation ?? h.conversationId} ${at} turn ${p?.offset ?? 0}: ${focus(redact(h.text), words, VOICE_MAX).replace(/\s*\n\s*/g, " / ")}`;
          })
        : ["(nothing found)"]
    );
  } catch (e) {
    return [`(voice search unavailable: ${(e as Error).message})`];
  }
}

/** `from`/`to` (local days, both included) bound every section. Each ranks by meaning and by words, fused (`fuse`). */
export async function search(words: string, o: DayRange = {}) {
  const range = dayRange(o.from, o.to);
  const { note, vector } = await embedQuery(words);
  // lifelog's search is a network call: the chats are read meanwhile.
  const holds = holdsAll(words);
  const [voice, chats, mail, all] = await Promise.all([
    voiceHits(words, range),
    chatHits(words, range, undefined, vector),
    mailHits(words, range, undefined, vector),
    episodesWhere(() => true),
  ]);
  const inside = all.filter(inDays(o));
  const ranked = fuse([
    readNearest(vector, () =>
      inside.map((m) => ({ id: m.id, text: episodeTextNow(m) }))
    ),
    inside
      .filter((m) => holds(episodeTextNow(m)))
      .toReversed()
      .map((m) => m.id),
  ]).map(([id]) => id);
  const top = new Set(ranked.slice(0, LIMIT));
  const found = inside.filter((m) => top.has(m.id));
  const situations = await readSituationsOf(
    words,
    new Set(all.map((m) => m.id)),
    new Set(found.map((m) => m.id)),
    !(o.from || o.to)
  );
  return withIndex((db) => [
    ...(note ? [note, ""] : []),
    ...situations,
    ...(found.length > 0
      ? [
          "Episodes (what happened):",
          ...found.map(episodeLine),
          ...(ranked.length > LIMIT
            ? [`(the best ${LIMIT}: narrow with \`from\` and \`to\`)`]
            : []),
          "",
        ]
      : []),
    ...(found.length > 0 ? ["Observations and units:"] : []),
    ...matches(db, words, o, vector),
    "",
    `Voice (exact spoken words, the best ${VOICE_LIMIT}: narrow with \`from\`/\`to\` for others; conversation id, time, turn: \`fetch <id> --from-turn <turn>\`):`,
    ...voice,
    "",
    "Chats and notes (the best passages: a chat's messages close in time, or a note's version; each heading says where to read more):",
    ...chats,
    "",
    `Mail (no newsletters: the best ${MAIL_HITS} thread-days; each its unit, \`fetch <unit>\` for the thread):`,
    ...mail,
  ]);
}

const SPACES = /\s+/;

/**
 * The situations a search opens with, so its hits are read knowing where things stand: whole, those of the people
 * `words` name (him aside), else his own when the search is about now (`isNow`: no days bound it); then, from every
 * other situation, the lines citing an episode the search shows (`shown`). `live`: the episodes there are.
 */
export async function readSituationsOf(
  words: string,
  live: ReadonlySet<string>,
  shown: ReadonlySet<string>,
  isNow: boolean
) {
  const { names, nameOf, truth } = await readPeople();
  const said = ` ${normalize(words).split(SPACES).join(" ")} `;
  const aliases = (ref: string) =>
    truth.people.find((p) => `person:${p.id}` === ref)?.aliases ?? [];
  const refs = await situated();
  const mentioned = refs.filter(
    (ref) =>
      ref !== OWNER &&
      [names.get(ref), ...aliases(ref)].some(
        (n) => n && said.includes(` ${normalize(n)} `)
      )
  );
  const whole = mentioned.length > 0 || !isNow ? mentioned : [OWNER];
  const title = (ref: string) =>
    ref === OWNER ? "His situation" : `Situation with ${nameOf(ref)}`;
  return [
    ...whole.flatMap((ref) =>
      situationBlock(title(ref), readSituationNow(ref, live))
    ),
    ...refs
      .filter((ref) => !whole.includes(ref))
      .flatMap((ref) =>
        situationBlock(
          `${title(ref)}, on the episodes below`,
          readSituationNow(ref, live).filter((l) =>
            l.cites.some((id) => shown.has(id))
          )
        )
      ),
  ];
}
