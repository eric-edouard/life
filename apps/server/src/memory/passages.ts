import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { clock, DAY, daysBefore, iso, MIN } from "../core/clock";
import { CANDIDATES, EMBEDDER_MODEL, textHashOf } from "../core/embedder";
import { openReadOnly } from "../core/sqlite";
import type { SourceEvent } from "../records/source";
import { PASSAGES } from "./ledger";
import {
  enabledSources,
  kindOf,
  readySources,
  SOURCES,
  type Tables,
  tables,
} from "./sources";
import { dayUnitId, isLifeOutput, normalize, searchableMail } from "./units";
import type { Searched } from "./vectors";
import { type DayRange, dayStart, localDate, type Window } from "./zones";

// Rebuildable source text, independent of index.sqlite. Each passage belongs to its first message's unit.
const GAP = 30 * MIN;
const MAX_MESSAGES = 12;
const MAX_CHARS = 700;
const SCHEMA = `
create table if not exists passages (id text primary key, unit text, source text, chat text, start text, end text, hash text, text text, events text, normalized text, run_start text, run_end text);
create index if not exists passages_dates on passages(source, start, end);
create table if not exists coverage (source text, start text, end text, primary key(source,start));`;

/** A chat's consecutive messages, anchored after a natural silence; writing a neighboring day keeps the same cuts. */
export function passagesOf(events: SourceEvent[]) {
  const passages: SourceEvent[][] = [];
  const chats = Map.groupBy(events, (e) => `${e.source}|${e.chat}`);
  for (const list of chats.values()) {
    let open: SourceEvent[] = [];
    let chars = 0;
    for (const e of list.toSorted(
      (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)
    )) {
      const last = open.at(-1);
      if (
        last &&
        kindOf(e.source) === "chat" &&
        open.length < MAX_MESSAGES &&
        chars + e.text.length <= MAX_CHARS &&
        Date.parse(e.at) - Date.parse(last.at) <= GAP
      ) {
        open.push(e);
        chars += e.text.length;
      } else {
        open = [e];
        chars = e.text.length;
        passages.push(open);
      }
    }
  }
  return passages;
}

export interface Passage {
  end: string;
  events: SourceEvent[];
  hash: string;
  id: string;
  source: string;
  start: string;
  text: string;
  unit: string;
}
type Stored = Omit<Passage, "events"> & { events: string };

const rowOf = (events: SourceEvent[]): Passage => {
  const first = events[0] as SourceEvent;
  const text = events.map((e) => e.text).join("\n");
  return {
    end: events.at(-1)?.at ?? first.at,
    events,
    hash: textHashOf(EMBEDDER_MODEL, text),
    id: `${first.source}|${first.id}`,
    source: first.source,
    start: first.at,
    text,
    unit: dayUnitId(first),
  };
};

type Readers = Partial<Tables["SEARCHED"]>;
/** Extend one chat's edge until a natural silence, in bounded storage reads. */
function edgeOf(
  events: SourceEvent[],
  source: string,
  chat: string,
  initial: number,
  direction: number,
  read: NonNullable<Readers[keyof Readers]>
) {
  const out: SourceEvent[] = [];
  let edge = initial;
  const ordered = events
    .filter((e) => e.source === source && e.chat === chat)
    .sort((a, b) => a.at.localeCompare(b.at));
  let last = (direction < 0 ? ordered[0] : ordered.at(-1))?.at;
  while (
    last &&
    Math.abs(Date.parse(last) - edge) <= GAP &&
    edge > 0 &&
    edge < clock().getTime()
  ) {
    const start = Math.max(0, direction < 0 ? edge - DAY : edge);
    const end = direction < 0 ? edge : Math.min(edge + DAY, clock().getTime());
    const adjacent = read(new Date(start), new Date(end))
      .filter((e) => e.chat === chat && !isLifeOutput(e))
      .sort((a, b) => a.at.localeCompare(b.at));
    const list = direction < 0 ? adjacent.toReversed() : adjacent;
    let joined = 0;
    for (const event of list) {
      if (Math.abs(Date.parse(last) - Date.parse(event.at)) > GAP) {
        break;
      }
      out.push(event);
      joined += 1;
      last = event.at;
    }
    edge = direction < 0 ? start : end;
    if (!joined || Math.abs(Date.parse(last) - edge) > GAP) {
      break;
    }
  }
  return out;
}

/** A full natural run anchors the size-based cuts, even across many midnights. */
function readEdges(
  events: SourceEvent[],
  from: string,
  to: string,
  readers: Readers
) {
  const out = new Map(events.map((e) => [`${e.source}|${e.id}`, e]));
  const chats = Map.groupBy(
    events.filter((e) => kindOf(e.source) === "chat"),
    (e) => `${e.source}|${e.chat}`
  );
  for (const list of chats.values()) {
    const first = list[0] as SourceEvent;
    const read = readers[first.source];
    if (!read) {
      continue;
    }
    for (const direction of [-1, 1]) {
      const edge = Date.parse(direction < 0 ? from : to);
      for (const e of edgeOf(
        list,
        first.source,
        first.chat,
        edge,
        direction,
        read
      )) {
        out.set(`${e.source}|${e.id}`, e);
      }
    }
  }
  return [...out.values()];
}

/** Natural run bounds are computed once, independently of the size-based passage cuts. */
function runBoundsOf(events: SourceEvent[]) {
  const bounds = new Map<string, { start: string; end: string }>();
  for (const list of Map.groupBy(
    events,
    (e) => `${e.source}|${e.chat}`
  ).values()) {
    let run: { start: string; end: string } | undefined;
    let last: SourceEvent | undefined;
    for (const e of list.toSorted(
      (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)
    )) {
      if (
        !(run && last) ||
        kindOf(e.source) !== "chat" ||
        Date.parse(e.at) - Date.parse(last.at) > GAP
      ) {
        run = { end: e.at, start: e.at };
      }
      run.end = e.at;
      bounds.set(`${e.source}|${e.id}`, run);
      last = e;
    }
  }
  return bounds;
}

/** Previously published edge refs widen a retry even when those messages were deleted at the source. */
function refreshedOf(
  events: SourceEvent[],
  from: string,
  to: string,
  readers: Readers,
  path: string
) {
  const intervals = new Map<string, { from: string; to: string }>();
  const db = existsSync(path) ? openReadOnly(path) : null;
  try {
    for (const [source, read] of Object.entries(readers)) {
      if (!read) {
        continue;
      }
      const old = db
        ?.query<
          { first: string | null; last: string | null },
          [string, string, string]
        >(
          "select min(run_start) first,max(run_end) last from passages where source = ? and run_end >= ? and run_start < ?"
        )
        .get(source, from, to);
      const start = old?.first && old.first < from ? old.first : from;
      const end =
        old?.last && old.last >= to ? iso(Date.parse(old.last) + 1) : to;
      intervals.set(source, { from: start, to: end });
    }
  } finally {
    db?.close();
  }
  const refreshed = Object.entries(readers).flatMap(([source, read]) => {
    const r = intervals.get(source);
    if (!(read && r)) {
      return [];
    }
    return r.from === from && r.to === to
      ? events.filter((e) => e.source === source)
      : read(new Date(r.from), new Date(r.to));
  });
  return { events: refreshed.filter((e) => !isLifeOutput(e)), intervals };
}

/** One boundary storage query per source/interval, shared by every chat in that interval. */
function cachedReaders(readers: Readers): Readers {
  return Object.fromEntries(
    Object.entries(readers).map(([source, read]) => {
      const cache = new Map<string, SourceEvent[]>();
      return [
        source,
        (from: Date, to?: Date) => {
          const key = `${from.toISOString()}|${to?.toISOString() ?? ""}`;
          let events = cache.get(key);
          if (!events) {
            events = read?.(from, to) ?? [];
            cache.set(key, events);
          }
          return events;
        },
      ];
    })
  );
}

function publishPassageRows(
  db: Database,
  eligible: SourceEvent[],
  bounds: ReturnType<typeof runBoundsOf>
) {
  const insert = db.prepare(
    "insert or replace into passages values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const [source, list] of Map.groupBy(eligible, (e) => e.source)) {
    const groups =
      kindOf(source) === "mail"
        ? searchableMail(list).flatMap((g) => g.map((e) => [e]))
        : passagesOf(list);
    for (const group of groups) {
      const p = rowOf(group);
      const run = bounds.get(p.id) as { start: string; end: string };
      insert.run(
        p.id,
        p.unit,
        p.source,
        (group[0] as SourceEvent).chat,
        p.start,
        p.end,
        p.hash,
        p.text,
        JSON.stringify(p.events),
        normalize(p.text),
        run.start,
        run.end
      );
    }
  }
}

/** Reconcile complete chat runs together; retries and adjacent months replace the same global passage identities. */
export function preparePassages(
  events: SourceEvent[],
  window: Window,
  skipped: string[] = [],
  readers?: Readers,
  path = PASSAGES,
  deferredDays: ReadonlySet<string> = new Set()
) {
  const from = dayStart(window.from).toISOString();
  const to = dayStart(daysBefore(window.to, -1)).toISOString();
  const sources = readers ?? {
    ...tables().SEARCHED,
    ...tables().SEARCHED_MAIL,
  };
  const selected = Object.keys(sources).filter((s) => !skipped.includes(s));
  const active = cachedReaders(
    Object.fromEntries(
      Object.entries(sources).filter(([source]) => selected.includes(source))
    )
  );
  const refreshed = refreshedOf(events, from, to, active, path);
  const expanded = [...refreshed.intervals].flatMap(([source, r]) =>
    readEdges(
      refreshed.events.filter((e) => e.source === source),
      r.from,
      r.to,
      { [source]: active[source as keyof Readers] }
    )
  );
  const bounds = runBoundsOf(expanded);
  const dates = expanded.map((e) => localDate(e.at)).sort();
  const context = {
    from: dates[0] ?? window.from,
    to: dates.at(-1) ?? window.to,
  };
  const publish = (deferred: ReadonlySet<string> = deferredDays) => {
    const blocked = new Set(
      expanded
        .filter((e) => deferred.has(localDate(e.at)))
        .map((e) => bounds.get(`${e.source}|${e.id}`))
    );
    const eligible = expanded.filter(
      (e) => !blocked.has(bounds.get(`${e.source}|${e.id}`))
    );
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.run("pragma busy_timeout = 30000");
    db.run("pragma journal_mode = wal");
    db.run(SCHEMA);
    try {
      db.transaction(() => {
        for (const [source, r] of refreshed.intervals) {
          db.query(
            "delete from passages where source = ? and end >= ? and start < ?"
          ).run(source, r.from, r.to);
          if (!blocked.size) {
            db.query("insert or replace into coverage values (?, ?, ?)").run(
              source,
              from,
              to
            );
          }
        }
        for (const list of Map.groupBy(
          expanded,
          (e) => `${e.source}|${e.chat}`
        ).values()) {
          const ordered = list.toSorted((a, b) => a.at.localeCompare(b.at));
          const first = ordered[0] as SourceEvent;
          db.query(
            "delete from passages where source = ? and chat = ? and end >= ? and start <= ?"
          ).run(
            first.source,
            first.chat,
            first.at,
            ordered.at(-1)?.at ?? first.at
          );
        }
        publishPassageRows(db, eligible, bounds);
      }).immediate();
    } finally {
      db.close(true);
    }
  };
  return Object.assign(publish, { window: context });
}

/** Publish only after every boundary read and validation in the month succeeded. */
export function writePassages(...args: Parameters<typeof preparePassages>) {
  preparePassages(...args)();
}

function filterOf(range: DayRange, mail: boolean) {
  return {
    args: [
      range.from ?? "",
      range.to ?? iso(clock().getTime() + 1),
      JSON.stringify(
        SOURCES.filter((s) => s.kind === "mail").map((s) => s.name)
      ),
    ],
    sql: `end >= ? and start < ? and source ${mail ? "in" : "not in"} (select value from json_each(?))`,
  };
}

/** Candidate ids/hashes only: texts and source events are loaded only after ranking. */
export function readPassageCandidates(
  words: string,
  range: DayRange,
  mail = false,
  path = PASSAGES,
  hasVector = false
) {
  if (!existsSync(path)) {
    return {
      count: 0,
      hashes: [] as { id: string; hash: string }[],
      held: [] as string[],
    };
  }
  const db = openReadOnly(path);
  const f = filterOf(range, mail);
  const terms = normalize(words).split(" ").filter(Boolean);
  const where = `${f.sql} and ${terms.length ? terms.map(() => "instr(normalized, ?) > 0").join(" and ") : "0"}`;
  const args = [...f.args, ...terms];
  try {
    return {
      count:
        db
          .query<{ n: number }, string[]>(
            `select count(${mail ? "distinct unit" : "*"}) n from passages where ${where}`
          )
          .get(...args)?.n ?? 0,
      hashes: hasVector
        ? db
            .query<{ id: string; hash: string }, string[]>(
              `select id, hash from passages where ${f.sql}`
            )
            .all(...f.args)
        : [],
      held: db
        .query<{ id: string }, string[]>(
          `select id${mail ? ", max(end)" : ""} from passages where ${where}${mail ? " group by unit" : ""} order by ${mail ? "max(end)" : "end"} desc limit ${CANDIDATES}`
        )
        .all(...args)
        .map((p) => p.id),
    };
  } finally {
    db.close();
  }
}

/** Source text for selected ranked rows, or an explicit bounded rebuild/embedding read. */
export function readPassages(
  range: DayRange = {},
  mail = false,
  path = PASSAGES,
  ids?: string[]
): Passage[] {
  if (!existsSync(path)) {
    return [];
  }
  const db = openReadOnly(path);
  const f = filterOf(range, mail);
  try {
    return db
      .query<Stored, string[]>(
        `select id, unit, source, start, end, hash, text, events from passages where ${f.sql}${ids ? " and id in (select value from json_each(?))" : ""} order by end desc`
      )
      .all(...f.args, ...(ids ? [JSON.stringify(ids)] : []))
      .map((p) => ({ ...p, events: JSON.parse(p.events) as SourceEvent[] }));
  } finally {
    db.close();
  }
}

/** Coverage must span every source without a gap before absent hashes can safely be pruned. */
export function readPassageTexts(): { texts: Searched[]; isWhole: boolean } {
  if (!existsSync(PASSAGES)) {
    return { isWhole: false, texts: [] };
  }
  const db = openReadOnly(PASSAGES);
  try {
    const ready = readySources();
    const searched = enabledSources().filter(
      (s) => s.kind === "chat" || s.kind === "own_writing" || s.kind === "mail"
    );
    const isWhole = searched.every((source) => {
      if (!ready.includes(source)) {
        return false;
      }
      let earliest: string | null | undefined;
      try {
        earliest = source.earliest?.();
      } catch {
        return false;
      }
      if (!earliest) {
        return true;
      }
      let edge = earliest;
      for (const r of db
        .query<{ start: string; end: string }, [string]>(
          "select start,end from coverage where source = ? order by start"
        )
        .all(source.name)) {
        if (r.start > edge) {
          return false;
        }
        if (r.end > edge) {
          edge = r.end;
        }
      }
      return edge >= clock().toISOString();
    });
    return {
      isWhole,
      texts: db
        .query<Searched, []>(
          "select end as at,hash,text from passages order by end desc"
        )
        .all(),
    };
  } finally {
    db.close();
  }
}
