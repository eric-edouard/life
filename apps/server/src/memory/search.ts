import type { Database } from "bun:sqlite";
import { CANDIDATES } from "../core/embedder";
import { fuse } from "../core/fusion";
import { redact } from "../core/redact";
import { readOwnerName } from "../models/prompt-parts";
import { turnPlace, withStore } from "../sources/voice-server";
import { searchVoice } from "../sources/voice-server-search";
import {
  currentSummaries,
  summaryLine,
  summaryTextOf,
} from "./conversation-summaries";
import { type Deletions, isCut, isGone } from "./deletions";
import {
  COLUMNS,
  CURRENT,
  episodeLine,
  episodeTextNow,
  LIMIT,
  line,
  type Row,
  type UnitRow,
  unitLine,
  withIndex,
} from "./index-rows";
import { deletionsNow, episodesWhere, readIndex } from "./memory-files";
import { directoryPartiesOf, OWNER } from "./read-truth";
import { situationBlock } from "./situation-parts";
import { readSituationNow, situated } from "./situations";
import { listening } from "./sources";
import { holdsName } from "./units";
import { embedQuery, readNearest } from "./vectors";
import { readPeople } from "./who";
import { chatHits, focus, holdsAll, MAIL_HITS, mailHits } from "./words";
import {
  type DayRange,
  dayRange,
  daysMeet,
  inDays,
  localDate,
  localTime,
} from "./zones";

// `bun life memory search <words>` and the connector's `search`: episodes, observations and units matching the words
// (from derived/memory/index.sqlite), the exact spoken words (the voice server's search), chats and mail, each ranked by meaning
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

/**
 * The ids best for an FTS `query`, fused (`fuse`): by meaning (`vector` against the stored hashes `hashes` selects) and by
 * words (`words`, its rows ranked by FTS), both over `args`.
 */
function rankedIds(
  db: Database,
  query: string,
  vector: number[] | undefined,
  sql: { hashes: string; words: string },
  args: string[]
) {
  return fuse([
    readNearest(vector, () =>
      db.query<{ id: string; hash: string }, string[]>(sql.hashes).all(...args)
    ),
    query
      ? db
          .query<{ id: string }, string[]>(sql.words)
          .all(query, ...args)
          .map((r) => r.id)
      : [],
  ])
    .slice(0, LIMIT + 1)
    .map(([id]) => id);
}

/**
 * The ids of the units best for `q` within `range`, by meaning (`vector`) and by words: `AND` holds every word
 * (search), `OR` any, ranked by FTS (a matter's evidence: its words are never all in a mail's).
 */
export function rankedUnitIds(
  db: Database,
  q: string,
  range: DayRange,
  vector: number[] | undefined,
  op: "AND" | "OR" = "AND"
) {
  const u = between("u.date", range);
  return rankedIds(
    db,
    ftsQuery(q, op),
    vector,
    {
      hashes: `select u.id, h.hash from units u join search_hashes h on h.id = u.id where 1${u.sql}`,
      words: `select u.id from unit_search s join units u on u.id = s.id
          where unit_search match ?${u.sql} order by rank limit ${CANDIDATES}`,
    },
    u.args
  );
}

/** The units of `ids`, in their order. */
export const unitRowsOf = (db: Database, ids: string[]) =>
  rowsFor<UnitRow>(
    db,
    "select id, date, source, title, topics from units where id in (select value from json_each(?))",
    ids
  );

/** The observations and units best for `q` by meaning (`vector`) and by words (holding them all), fused (`fuse`). */
export function matches(
  db: Database,
  q: string,
  range: DayRange = {},
  vector?: number[]
) {
  const o = between("o.date", range);
  const observations = rowsFor<Row>(
    db,
    `select ${COLUMNS} from observations o where o.id in (select value from json_each(?))`,
    rankedIds(
      db,
      ftsQuery(q, "AND"),
      vector,
      {
        hashes: `select o.id, h.hash from observations o join search_hashes h on h.id = o.id where ${CURRENT}${o.sql}`,
        words: `select o.id from search s join observations o on o.id = s.id
          where search match ? and ${CURRENT}${o.sql} order by rank limit ${CANDIDATES}`,
      },
      o.args
    )
  ).map(line);
  const units = unitRowsOf(db, rankedUnitIds(db, q, range, vector)).map(
    unitLine
  );
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

/** A passage of `search` as it shows: a turn of its span gone whole or cut in drops it, since its words are the voice server's as they were. */
export const shownVoiceHitsOf = <
  H extends { firstTurn: number; jobId: string; lastTurn: number },
>(
  hits: H[],
  d: Deletions = deletionsNow()
) =>
  hits.filter((h) => {
    for (let i = h.firstTurn; i <= h.lastTurn; i += 1) {
      const ref = `${h.jobId}:${i}`;
      if (isGone(ref, d) || isCut(ref, d)) {
        return false;
      }
    }
    return true;
  });

/** The voice section of `search`: The voice server's best passages for the words, each with its place in its conversation. */
async function voiceHits(words: string, range: DayRange) {
  if (!listening()) {
    return ["(no voice source)"];
  }
  try {
    const hits = shownVoiceHitsOf(await searchVoice(words, range, VOICE_LIMIT));
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

/** The ids of `items` best for the query: by meaning (`vector`, the stored hashes of their texts) and by words (`holds`), fused (`fuse`). */
function rankedOf(
  vector: number[] | undefined,
  items: { id: string; text: string }[],
  holds: (text: string) => boolean
) {
  return fuse([
    readNearest(
      vector,
      () =>
        readIndex((db) =>
          db
            .query<{ id: string; hash: string }, [string]>(
              "select id, hash from search_hashes where id in (select value from json_each(?))"
            )
            .all(JSON.stringify(items.map((i) => i.id)))
        ) ?? []
    ),
    items
      .filter((i) => holds(i.text))
      .toReversed()
      .map((i) => i.id),
  ]).map(([id]) => id);
}

/** `from`/`to` (local days, both included) bound every section. Each ranks by meaning and by words, fused (`fuse`). */
export async function search(words: string, o: DayRange = {}) {
  const range = dayRange(o.from, o.to);
  const { note, vector } = await embedQuery(words);
  // The voice server's search is a network call: the chats are read meanwhile.
  const holds = holdsAll(words);
  const [voice, chats, mail, all, summaries] = await Promise.all([
    voiceHits(words, range),
    chatHits(words, range, vector),
    mailHits(words, range, vector),
    episodesWhere(() => true),
    currentSummaries(),
  ]);
  const inside = all.filter(inDays(o));
  const ranked = rankedOf(
    vector,
    inside.map((m) => ({ id: m.id, text: episodeTextNow(m) })),
    holds
  );
  const top = new Set(ranked.slice(0, LIMIT));
  const found = inside.filter((m) => top.has(m.id));
  const spoken = summaries.filter((h) => daysMeet(o, localDate(h.at)));
  const rankedSummaries = rankedOf(
    vector,
    spoken.map((h) => ({ id: h.ref, text: summaryTextOf(h) })),
    holds
  );
  const topSummaries = rankedSummaries.slice(0, LIMIT);
  const foundSummaries = topSummaries.flatMap(
    (id) => spoken.find((h) => h.ref === id) ?? []
  );
  const situations = await readSituationsOf(
    words,
    all,
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
    ...(foundSummaries.length > 0
      ? [
          "Conversation summaries (long conversations recorded in person, written from every line; `fetch <ref>` opens one):",
          ...foundSummaries.map(summaryLine),
          ...(rankedSummaries.length > LIMIT
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
    "Chats and notes (the best passages: a chat's messages close in time, a note's version, or one photo with its place, scenes, words and description; each heading says where to read more):",
    ...chats,
    "",
    `Mail (no newsletters: the best ${MAIL_HITS} thread-days; each its unit, \`fetch <unit>\` for the thread):`,
    ...mail,
  ]);
}

/**
 * The situations a search opens with, so its hits are read knowing where things stand: whole, those of the people
 * `words` name (him aside), else his own when the search is about now (`isNow`: no days bound it); then, from every
 * other situation, the parts citing an episode the search shows (`shown`). `episodes`: those there are.
 */
export async function readSituationsOf(
  words: string,
  episodes: Parameters<typeof readSituationNow>[1],
  shown: ReadonlySet<string>,
  isNow: boolean
) {
  const { names, nameOf, refOf, truth } = await readPeople();
  const aliases = (ref: string) =>
    directoryPartiesOf(truth).find((p) => `person:${p.id}` === ref)?.aliases ??
    [];
  const refs = await situated();
  const mentioned = refs.filter(
    (ref) =>
      ref !== OWNER && holdsName(words, [names.get(ref), ...aliases(ref)])
  );
  const whole = mentioned.length > 0 || !isNow ? mentioned : [OWNER];
  const title = (ref: string) =>
    ref === OWNER
      ? `${readOwnerName()}'s situation`
      : `Situation with ${nameOf(ref)}`;
  return [
    ...whole.flatMap((ref) =>
      situationBlock(title(ref), readSituationNow(ref, episodes, refOf))
    ),
    ...refs
      .filter((ref) => !whole.includes(ref))
      .flatMap((ref) =>
        situationBlock(
          `${title(ref)}, on the episodes below`,
          readSituationNow(ref, episodes, refOf).filter((p) =>
            p.cites.some((id) => shown.has(id))
          )
        )
      ),
  ];
}
