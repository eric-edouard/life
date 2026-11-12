import { join } from "node:path";
import { z } from "zod";
import { clock } from "../core/clock";
import { filesIn, linesOf, readLineCount } from "../core/files";
import { OWNER_DATA_DIR } from "../core/paths";
import { git } from "../core/proc";
import {
  isBookkeeping,
  isTaskLine,
  LedgerEntry,
} from "../records/ledger-entry";
import {
  Correction,
  INFERRED_USE_AT,
  InferredPerson,
  Observation,
  ObservationId,
  Supersession,
} from "../records/observation";
import { Rating } from "../records/statement";
import {
  CORRECTIONS,
  hides,
  hiding,
  INFERRED,
  isCurrent,
  LEDGER,
  OBSERVATIONS,
  PAGE_KINDS,
  PAGES,
  RATINGS,
  readCorrections,
  readIndex,
  readInferred,
  readOrigins,
  readStanding,
  readUnit,
  readUnresolved,
  runAt,
  SUPERSESSIONS,
  stateOf,
} from "./ledger";
import { type Key, PageMeta, parsePage, readLine } from "./page-format";
import { OWNER } from "./read-truth";
import { kindOf } from "./sources";
import { aboutNow, authorFrom, chatHandles, readPeople } from "./who";

// What changed in the memory, and why to trust it, as JSON for the status reads: `read_memory_changes` (every observation, supersession,
// correction, inferred identity, action and page change, by cursor) and `read_observation` (one observation with its evidence).
// With run-log.ts (`read_processing_runs`) and host/status/life.ts (`lifeStatus`), the connector's status tools and `bun life memory changes|claim|status|runs`.
// Read-only: no model, no write, no source except `read_observation`'s cited unit (docs/status-reads.md). Lists are complete: every item is reachable through its cursor, never cut
// to "+N more". Contracts: docs/status-reads.md.

export const PAGE = 50;
export const MAX_PAGE = 500;

export const encode = (c: unknown) =>
  Buffer.from(JSON.stringify(c)).toString("base64url");
export function decode<T>(
  s: string | undefined,
  shape: z.ZodType<T>,
  empty: T
) {
  if (!s) {
    return empty;
  }
  try {
    return shape.parse(JSON.parse(Buffer.from(s, "base64url").toString()));
  } catch (e) {
    throw new Error("bad cursor: start again without one", { cause: e });
  }
}

// --- the change feed -----------------------------------------------------------------------------------------------

/** Each source's position: one past the last line (or row) the cursor covers. A line's position never changes. */
type Cursor = Record<string, number>;
/** A feed's cursor as a client sends it back (`encode`d); none starts at the beginning. */
export const parseCursor = (s: string | undefined): Cursor =>
  decode(s, z.record(z.string(), z.int().min(0)), {});

/**
 * A feed source: one past its last position (cheap: `readLineCount`, a store's last row) and its items from a position,
 * each at its own (a file's line numbers, a store's sparse rows), read only when the cursor is behind it.
 */
export interface Source<R> {
  end: number;
  name: string;
  rows: (from: number) => [number, R][];
}
/** A list as a feed source, each item at its index. */
export const listSource = <R>(name: string, list: R[]): Source<R> => ({
  end: list.length,
  name,
  rows: (from) => list.slice(from).map((r, i) => [from + i, r]),
});
/** An append-only file as a feed source. */
export const fileSource = (path: string, name: string): Source<string> => ({
  end: readLineCount(path),
  name,
  rows: (from) => listSource(name, linesOf(path)).rows(from),
});

/**
 * One page of a feed: the items `item` makes of the rows past `cursor`, source by source in the given order, at most
 * `limit`. The new cursor covers exactly the rows scanned (a source read to its end, its end), so the next page starts
 * where this one stopped and rows written anywhere meanwhile are picked up, none twice. `remaining` counts the items past
 * the new cursor. A source not given keeps its place.
 */
export function feedPage<R, T>(
  sources: Source<R>[],
  cursor: Cursor,
  limit: number,
  item: (source: string, row: R, n: number) => T | null
) {
  const next: Cursor = { ...cursor };
  const items: T[] = [];
  let remaining = 0;
  for (const s of sources) {
    const from = startOf(s, cursor);
    let taken = from;
    let full = false;
    for (const [n, row] of s.end > from ? s.rows(from) : []) {
      const it = item(s.name, row, n);
      full ||= items.length >= limit;
      if (full) {
        remaining += it ? 1 : 0;
      } else {
        if (it) {
          items.push(it);
        }
        taken = n + 1;
      }
    }
    next[s.name] = full ? taken : Math.max(taken, s.end);
  }
  return { cursor: encode(next), items, remaining };
}

/** Where a source's page starts: its place in the cursor, never past its end. */
function startOf(s: Source<unknown>, cursor: Cursor) {
  const from = cursor[s.name] ?? 0;
  if (s.end < from) {
    throw new Error(
      `cursor is past the end of ${s.name}: start again without a cursor`
    );
  }
  return from;
}

const PEOPLE_PATH = /^memory\/pages\/people\//;
const AREAS_PATH = /^memory\/pages\/areas\//;
const MD = /\.md$/;
const DIFF_FILE = /^diff --git /m;
/** A frontmatter line of a page (`built: …`, `lines: …`): every other changed line is the page's text. */
const FRONT_KEY = new RegExp(`^(${Object.keys(PageMeta.shape).join("|")}):`);
const A_PATH = /^a\/(\S+)/;

/** memory/pages/people/x.md -> person:x, memory/pages/areas/y.md -> area:y. */
const pageRef = (path: string) =>
  path
    .replace(PEOPLE_PATH, "person:")
    .replace(AREAS_PATH, "area:")
    .replace(MD, "");

/** Every committed change to a page file, oldest first, one line per commit and file (git keeps every page version). */
function pageCommits() {
  const out = git(OWNER_DATA_DIR, [
    "log",
    "--reverse",
    "--no-renames",
    "--format=%x01%H%x09%cI%x09%s",
    "--name-only",
    "--",
    "memory/pages",
  ]).stdout.toString();
  return out.split("\x01").flatMap((block) => {
    const [head = "", ...paths] = block.trim().split("\n");
    const [sha, at, subject] = head.split("\t");
    return paths
      .filter((p) => p.endsWith(".md"))
      .map((path) => JSON.stringify({ at, path, sha, subject }));
  });
}

/** The page lines each commit added and removed, by `<sha>:<path>`: body lines, not the frontmatter. One git call. */
function pageDiffs(shas: string[]) {
  const out = new Map<string, { added: string[]; removed: string[] }>();
  if (shas.length === 0) {
    return out;
  }
  const text = git(OWNER_DATA_DIR, [
    "show",
    "--no-color",
    "--unified=0",
    "--format=%x01%H",
    ...new Set(shas),
    "--",
    "memory/pages",
  ]).stdout.toString();
  for (const block of text.split("\x01").slice(1)) {
    const [sha = "", ...rest] = block.split("\n");
    for (const file of rest.join("\n").split(DIFF_FILE).slice(1)) {
      const lines = file.split("\n");
      const body = (sign: string) =>
        lines
          .filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3)))
          .map((l) => l.slice(1))
          .filter((l) => l.trim() !== "" && l !== "---" && !FRONT_KEY.test(l));
      out.set(`${sha}:${file.match(A_PATH)?.[1]}`, {
        added: body("+"),
        removed: body("-"),
      });
    }
  }
  return out;
}

/** The pages on disk (what the owner sees now), by ref, and the page lines citing each observation. */
async function readPages() {
  const cites = new Map<string, { line: string; page: string }[]>();
  const pages = new Map<string, Record<Key, string[]>>();
  const paths = (
    await Promise.all(
      PAGE_KINDS.map(async (dir) =>
        (await filesIn(join(PAGES, dir), ".md")).map((n) => join(PAGES, dir, n))
      )
    )
  ).flat();
  for (const text of await Promise.all(paths.map((p) => Bun.file(p).text()))) {
    const parsed = parsePage(text);
    if (parsed) {
      const { page } = parsed.meta;
      pages.set(page, parsed.raw);
      for (const [key, lines] of Object.entries(parsed.raw)) {
        for (const line of lines) {
          for (const id of readLine(key as Key, line).cites) {
            cites.set(id, [...(cites.get(id) ?? []), { line, page }]);
          }
        }
      }
    }
  }
  return { cites, pages };
}

/** The observation ids the search index holds, each with what retired it; null when there is no index. */
const indexed = () =>
  readIndex(
    (db) =>
      new Map(
        db
          .query<{ id: string; superseded_by: string | null }, []>(
            "select id, superseded_by from observations"
          )
          .all()
          .map((r) => [r.id, r.superseded_by])
      )
  );

/** What decides where an observation stands and whether a correction shows yet: the small ledgers, the pages, the index. */
async function readContext() {
  const [standing, inferred, pages] = await Promise.all([
    readStanding(readCorrections()),
    readInferred(),
    readPages(),
  ]);
  // The latest record for a surface wins (who.ts): its line number.
  const inferredLatest = new Map<string, number>();
  for (const [n, p] of inferred.entries()) {
    for (const s of p.surfaces) {
      inferredLatest.set(s, n);
    }
  }
  return {
    ...standing,
    index: indexed(),
    inferredLatest,
    pages,
  };
}
type Context = Awaited<ReturnType<typeof readContext>>;

/**
 * Has a correction reached the index and the pages yet? Exact for hidden observations (still in the index, still cited
 * on a page) and for a kept line (on its page). null: does not apply, no index, or an identity correction (not tracked).
 */
function reflected(c: Correction, ctx: Context) {
  const h = hides(c);
  if (h) {
    const cited = (id: string) =>
      (ctx.pages.cites.get(id) ?? []).some((p) => !h.page || p.page === h.page);
    return {
      index:
        h.page || !ctx.index
          ? null
          : !h.observations.some((id) => ctx.index?.has(id)),
      pages: !h.observations.some(cited),
    };
  }
  if (c.kind === "keep-mine") {
    // Any section: a line under one its page lacks shows in Now.
    const lines = Object.values(ctx.pages.pages.get(c.page) ?? {}).flat();
    return { index: null, pages: lines.some((l) => l.includes(c.text)) };
  }
  return { index: null, pages: null };
}

interface Item {
  /** Refs the item is about: person:, area:, project:, task: (what `about` filters on). */
  about: string[];
  /** When it happened in his life (a line said, a request made); null when it is Life's own act. */
  happenedAt: string | null;
  /** Stable: the ledger and line (`corrections#24`), or the commit and file for a page. */
  id: string;
  /** The ledger record as written (a page change: its commit and path). */
  record: object;
  /** When Life recorded it; for an observation, the start of the run that wrote it. */
  recordedAt: string;
  run: string | null;
  type: string;
  [extra: string]: unknown;
}

/** The task an action line is part of, as a ref: an ask's own id, a task line's target (a reply on no task has none). */
const taskRef = (a: LedgerEntry) => {
  if (a.kind === "ask") {
    return `task:${a.id}`;
  }
  return isTaskLine(a) && a.target !== "chat" ? `task:${a.target}` : null;
};

const refs = (list: unknown[]) =>
  list.filter((x): x is string => typeof x === "string" && x !== "");

/** The item one source line is: its record, typed by its source, with when and what it is about. */
function itemOf(
  source: string,
  line: string,
  n: number,
  ctx: Context
): Item | null {
  if (!line) {
    return null;
  }
  const id = `${source}#${n}`;
  const raw = JSON.parse(line);
  if (source === "pages") {
    const { at, ...record } = raw as { at: string; path: string; sha: string };
    const about = [pageRef(record.path)];
    const recordedAt = new Date(at).toISOString();
    const pageId = `page:${record.sha}:${record.path}`;
    return {
      about,
      happenedAt: null,
      id: pageId,
      record,
      recordedAt,
      run: null,
      type: "page.changed",
    };
  }
  if (source === "corrections") {
    const c = Correction.parse(raw);
    const r = c as Record<string, unknown>;
    const about = refs([r.page, r.person, r.from, r.to]);
    return {
      about,
      happenedAt: null,
      id,
      record: c,
      recordedAt: c.at,
      reflected: reflected(c, ctx),
      run: null,
      type: `correction.${c.kind}`,
    };
  }
  if (source === "supersessions") {
    const s = Supersession.parse(raw);
    return {
      about: refs([s.page]),
      happenedAt: null,
      id,
      record: s,
      recordedAt: s.at,
      run: s.madeBy.run,
      type: "observation.superseded",
    };
  }
  if (source === "inferred") {
    const p = InferredPerson.parse(raw);
    return {
      about: refs([`person:${p.id}`, p.area && `area:${p.area}`]),
      // The latest record for a surface wins: an older one no longer decides any surface.
      current: p.surfaces.some((s) => ctx.inferredLatest.get(s) === n),
      happenedAt: null,
      id,
      record: p,
      recordedAt: p.at,
      run: p.madeBy.run,
      type: "identity.inferred",
      used: p.confidence >= INFERRED_USE_AT,
    };
  }
  if (source === "ledger") {
    const a = LedgerEntry.parse(raw);
    if (isBookkeeping(a)) {
      return null;
    }
    const run = typeof a.via === "string" ? null : a.via.run;
    return {
      about: refs([taskRef(a)]),
      happenedAt: a.instruction?.at ?? a.at,
      id,
      record: a,
      recordedAt: a.at,
      run,
      // An ask is handed to the agent, not done by Life, and its task's lines are the agent's or Life's chasing: no outcome of their own.
      type:
        isTaskLine(a) || a.kind === "ask"
          ? `ledger.${a.kind}`
          : `ledger.${a.result}`,
    };
  }
  if (source === "ratings") {
    const r = Rating.parse(raw);
    return {
      about: [],
      happenedAt: null,
      id,
      record: r,
      recordedAt: r.at,
      run: null,
      type: `rating.${r.answer ?? "undone"}`,
    };
  }
  const o = Observation.parse(raw);
  return {
    about: refs([...o.entities, o.speaker, o.area && `area:${o.area}`]),
    happenedAt: o.at,
    id,
    record: o,
    recordedAt: runAt(o.madeBy.run),
    run: o.madeBy.run,
    status: stateOf(o, ctx),
    type: "observation.extracted",
  };
}

export interface ChangeFilter {
  /** A ref the change is about: person:<id>, area:<id>, project:<id>, task:<id> (an ask and its lines). */
  about?: string;
  cursor?: string;
  limit?: number;
  /** A run id (`madeBy.run`). */
  run?: string;
  /** Recorded at or after this ISO instant. */
  since?: string;
  /** Types or type prefixes: observation, observation.superseded, correction, identity, ledger, ledger.ask, ledger.update, ledger.nudge, ledger.steer, ledger.failed, rating, page. */
  types?: string[];
}

export const matchesFilter = (
  it: Pick<Item, "about" | "recordedAt" | "run" | "type">,
  f: ChangeFilter
) =>
  (!f.types?.length ||
    f.types.some((t) => it.type === t || it.type.startsWith(`${t}.`))) &&
  // A run id as `read_processing_runs` gives it (`memory.extract/<run>`) or bare.
  (!f.run || it.run === f.run.slice(f.run.lastIndexOf("/") + 1)) &&
  (!f.since || it.recordedAt >= new Date(f.since).toISOString()) &&
  (!f.about || it.about.includes(f.about));

const monthName = (file: string) =>
  `observations/${file.replace(".jsonl", "")}`;

/**
 * The change feed: every observation extracted, superseded, correction, inferred identity, logged action and committed
 * page change, past `cursor`. Sources in a fixed order (corrections, supersessions, inferred, actions, ratings, each month of
 * observations, pages); sort a page by `recordedAt` to show it. Page changes carry the lines added and removed.
 */
export async function changeFeed(f: ChangeFilter = {}) {
  const months = await filesIn(OBSERVATIONS);
  const pageLines = pageCommits();
  const sources: Source<string>[] = [
    fileSource(CORRECTIONS, "corrections"),
    fileSource(SUPERSESSIONS, "supersessions"),
    fileSource(INFERRED, "inferred"),
    fileSource(LEDGER, "ledger"),
    fileSource(RATINGS, "ratings"),
    ...months.map((m) => fileSource(join(OBSERVATIONS, m), monthName(m))),
    listSource("pages", pageLines),
  ];
  const ctx = await readContext();
  const page = feedPage(
    sources,
    parseCursor(f.cursor),
    f.limit ?? PAGE,
    (s, line, n) => {
      const it = itemOf(s, line, n, ctx);
      return it && matchesFilter(it, f) ? it : null;
    }
  );
  const commits = page.items.flatMap((it) =>
    it.type === "page.changed"
      ? [it.record as { path: string; sha: string }]
      : []
  );
  const diffs = pageDiffs(commits.map((c) => c.sha));
  return {
    count: page.items.length,
    cursor: page.cursor,
    items: page.items.map((it) => {
      const c = it.record as { path?: string; sha?: string };
      return it.type === "page.changed"
        ? { ...it, ...diffs.get(`${c.sha}:${c.path}`) }
        : it;
    }),
    observedAt: clock().toISOString(),
    remaining: page.remaining,
  };
}

// --- one claim with its evidence -----------------------------------------------------------------------------------

/**
 * One observation with everything that says how far to trust it: the claim and its lifecycle, the source (channel,
 * ref, time, speaker, quote), the unit to read it in (`fetch`, `read_chats`), who it is about as filed and as resolved now
 * (inferred people marked, with their confidence), the owner's corrections, supersessions, the pages that cite it and
 * whether the index still holds it. Every version of the claim in the ledger is listed.
 */
export async function claim(id: string) {
  if (!ObservationId.safeParse(id).success) {
    throw new Error("an observation id is obs_ and 12 hex");
  }
  const versions = [...(await readOrigins())].flatMap(([m, origins]) => {
    const ns = origins.flatMap((r) => (r.id === id ? [r.n] : []));
    const lines = ns.length > 0 ? linesOf(join(OBSERVATIONS, m)) : [];
    return ns.map((n) => ({
      id: `${monthName(m)}#${n}`,
      o: Observation.parse(JSON.parse(lines[n] as string)),
    }));
  });
  if (versions.length === 0) {
    throw new Error(`no observation ${id}`);
  }
  const ctx = await readContext();
  const o = (versions.find((v) => isCurrent(ctx, v.o)) ?? versions.at(-1))
    ?.o as Observation;
  const people = await readPeople();
  const unit = await readUnit(o.unit);
  const chats = chatHandles(unit ? [unit] : []);
  const now = aboutNow(
    [o],
    await readUnresolved(),
    people.truth.people,
    people.inferred,
    people.corrections,
    chats,
    people.contacts
  )[0] as Observation;
  const inferred = new Map(people.inferred.map((p) => [`person:${p.id}`, p]));
  const handle = o.speaker === OWNER ? "me" : (authorFrom(o, chats) ?? null);
  const chat = unit && kindOf(unit.source) === "chat";
  return {
    corrections: [
      ...hiding(ctx.corrections, id),
      ...ctx.corrections.filter((c) => "surface" in c && c.surface === handle),
    ],
    entities: now.entities.map((ref) => {
      const inferredPerson = inferred.get(ref);
      return {
        filed: (o.entities as string[]).includes(ref),
        inferred: inferredPerson
          ? {
              confidence: inferredPerson.confidence,
              relation: inferredPerson.relation,
            }
          : null,
        name: people.names.get(ref) ?? null,
        ref,
      };
    }),
    index: ctx.index
      ? { holds: ctx.index.has(id), supersededBy: ctx.index.get(id) ?? null }
      : null,
    observation: o,
    observedAt: clock().toISOString(),
    pages: ctx.pages.cites.get(id) ?? [],
    read: unit
      ? [
          { id: unit.id, tool: "fetch" },
          ...(chat
            ? [{ chat: unit.key, from: o.date, to: o.date, tool: "read_chats" }]
            : []),
        ]
      : [],
    replaces: [...ctx.retired.values()].filter(
      (s) => s.by === id && s.observation !== id
    ),
    speaker: {
      filed: o.speaker,
      handle,
      name: now.speakerName ?? people.names.get(now.speaker) ?? null,
      now: now.speaker,
    },
    status: stateOf(o, ctx),
    unit: unit
      ? {
          date: unit.date,
          id: unit.id,
          key: unit.key,
          source: unit.source,
          title: unit.title,
        }
      : null,
    versions: versions.map((v) => ({
      id: v.id,
      prompt: v.o.madeBy.prompt,
      recordedAt: runAt(v.o.madeBy.run),
      run: v.o.madeBy.run,
      status: stateOf(v.o, ctx).state,
    })),
  };
}
