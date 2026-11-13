import { z } from "zod";
import { daysBefore } from "../core/clock";
import { digest } from "../core/hash";
import { MadeBy } from "../records/fields";
import { type Observation, PageSection } from "../records/observation";
import { KEEP_AT } from "../records/unit";
import {
  type ObservationStatusInputs,
  observationStatusOf,
  shows,
} from "./memory-files";
import { OWNER, othersIn, type Truth } from "./read-truth";
import { normalize } from "./units";

// The pure parts of pages (docs/architecture.md, "The pipeline"): a page's file format, where each observation lives, the owner's
// edits found in a page, the consolidation reply checked and merged into the previous page, and the rules code
// enforces (no churn, aging, the word budget). No disk, network or clock.

export type Key = z.infer<typeof PageSection>;

/**
 * Every section a page can have, in page order (`PageSection`'s). The live ones hold where things stand: a line ages
 * into History when no cited observation is newer than `ages` days (never, without it). Only the owner's page has
 * Views and Health.
 */
const SECTION: Record<Key, { ages?: number; title: string }> = {
  // What lasts between him and someone close (the relationship, agreements, boundaries, turning points): a line leaves
  // when it is done, replaced, or a year goes by with nothing newer behind it.
  bond: { ages: 365, title: "Between us" },
  health: { ages: 60, title: "Health" },
  history: { title: "History" },
  now: { ages: 21, title: "Now" },
  views: { title: "Views, values and habits" },
};
const SECTIONS = PageSection.options.map((key) => ({ key, ...SECTION[key] }));
const LIVE = SECTIONS.filter((s) => s.key !== "history");

/**
 * What a page has: its live sections and words ("What I hold" included). The owner's page has Views and Health; the
 * page of someone close to him personally (`close`: their closeness level) has Between us and more words.
 */
export const layoutOf = (ref: string, close = false) => {
  if (ref === OWNER) {
    return { live: LIVE.filter((s) => s.key !== "bond"), words: 2000 };
  }
  return close
    ? {
        live: LIVE.filter((s) => s.key === "bond" || s.key === "now"),
        words: 1100,
      }
    : { live: LIVE.filter((s) => s.key === "now"), words: 800 };
};
export type Layout = ReturnType<typeof layoutOf>;
const hasSection = (l: Layout, key: Key) =>
  key === "history" || l.live.some((s) => s.key === key);
/** History keeps this many lines at most, oldest dropped first. */
const HISTORY_MAX = 30;
/** Words kept free for History when the live sections are long: their oldest lines move there beyond this. */
const HISTORY_ROOM = 150;
const HOLD = "What I hold";
const OFTEN = "Often talk about";
const CITES = / ?\[(obs_[0-9a-f]{12}(?:, obs_[0-9a-f]{12})*)\]$/;
const BULLET = /^- /;
const DATED = /^(\d{4}-\d{2}-\d{2}) · (.*)$/;
const FRONT = /^---\n([\s\S]*?)\n---\n/;
const HEADING = /^## (.+)$/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s+/;

/** A generated line: its words, the observations it rests on and, in History, the day it is about. */
export interface PageLine {
  cites: string[];
  date?: string;
  text: string;
}
/** A page's lines by section; the sections a page shows are `layoutOf`'s. */
export type Sections = Record<Key, PageLine[]>;

export const PageMeta = z.object({
  built: z.string(),
  /** Hash of each generated line -> the observations it cites. A line not listed here is the owner's. */
  lines: z.record(z.string(), z.array(z.string())),
  madeBy: MadeBy,
  name: z.string(),
  /** Observations it was offered because who they are about changed since they were written (`refiled`): not again. */
  offered: z.array(z.string()).optional(),
  page: z.string(),
  schemaVersion: z.literal(1),
  /** The newest extraction run (`madeBy.run`) the page has read; later observations are new to it. */
  seen: z.string(),
});
export type PageMeta = z.infer<typeof PageMeta>;

/** A page as found on disk: its frontmatter and, per section, the lines in it (generated or the owner's). */
export interface Parsed {
  meta: PageMeta;
  raw: Record<Key, string[]>;
}

export const perSection = <T>() =>
  Object.fromEntries(SECTIONS.map((s) => [s.key, [] as T[]])) as Record<
    Key,
    T[]
  >;

export const lineHash = (line: string) => digest("sha1", line.trim(), 10);

export function renderLine(key: Key, l: PageLine) {
  const cites = ` [${l.cites.join(", ")}]`;
  return key === "history"
    ? `- ${l.date} · ${l.text}${cites}`
    : `- ${l.text}${cites}`;
}

/** A line's words without its bullet and cites, to compare lines. */
export const bare = (line: string) =>
  line.replace(BULLET, "").replace(CITES, "").trim();

/** A generated line read back from its section (the inverse of renderLine). */
export function readLine(key: Key, line: string): PageLine {
  const cites = line.match(CITES)?.[1]?.split(", ") ?? [];
  const body = bare(line);
  if (key === "history") {
    const m = body.match(DATED);
    return { cites, date: m?.[1], text: m?.[2] ?? body };
  }
  return { cites, text: body };
}

export function parsePage(text: string): Parsed | null {
  const front = text.match(FRONT);
  const meta = PageMeta.safeParse(front?.[1] ? Bun.YAML.parse(front[1]) : null);
  if (!(front && meta.success)) {
    return null;
  }
  const raw = perSection<string>();
  let key: Key | null = null;
  for (const line of text.slice(front[0].length).split("\n")) {
    const heading = line.match(HEADING)?.[1];
    if (heading !== undefined) {
      key = SECTIONS.find((s) => s.title === heading)?.key ?? null;
    } else if (key && line.trim()) {
      raw[key].push(line.trimEnd());
    }
  }
  return { meta: meta.data, raw };
}

/**
 * The owner's edits since the page was written: lines he wrote or rewrote (not among the generated hashes), and
 * generated lines he deleted (by the observations they cited).
 */
export function ownerEdits(p: Parsed) {
  const present = new Set<string>();
  const lines: { section: Key; text: string }[] = [];
  for (const { key } of SECTIONS) {
    for (const line of p.raw[key]) {
      const h = lineHash(line);
      present.add(h);
      if (!(h in p.meta.lines)) {
        lines.push({ section: key, text: line });
      }
    }
  }
  const removed = Object.entries(p.meta.lines).flatMap(([h, cites]) =>
    present.has(h) ? [] : [cites]
  );
  return { lines, removed };
}

/** The generated lines of a parsed page, by section (the owner's left out). */
export function generated(p: Parsed): Sections {
  const out = perSection<PageLine>();
  for (const { key } of SECTIONS) {
    out[key] = p.raw[key]
      .filter((l) => lineHash(l) in p.meta.lines)
      .map((l) => readLine(key, l));
  }
  return out;
}

/** Words a reader sees in `text`: cites, bullets and bare punctuation do not count. */
export const wordsOf = (text: string) =>
  bare(text)
    .split(SPACE)
    .filter((w) => WORD.test(w)).length;

export function renderPage(opts: {
  hold: string;
  layout: Layout;
  meta: Omit<PageMeta, "lines">;
  /** Lines of "Often talk about" (person pages), computed by code. */
  often?: string[];
  owner: { section: Key; text: string }[];
  sections: Sections;
  title: string;
}) {
  const lines: PageMeta["lines"] = {};
  const body = [`# ${opts.title}`, "", `## ${HOLD}`, "", opts.hold.trim(), ""];
  const { layout } = opts;
  for (const { key, title } of SECTIONS.filter((s) =>
    hasSection(layout, s.key)
  )) {
    const section = [
      ...opts.sections[key].map((l) => {
        const text = renderLine(key, l);
        lines[lineHash(text)] = l.cites;
        return text;
      }),
      // His line under a section this page doesn't have stays his, in Now.
      ...opts.owner
        .filter(
          (x) => (hasSection(layout, x.section) ? x.section : "now") === key
        )
        .map((o) => o.text),
    ];
    body.push(
      `## ${title}`,
      "",
      ...section,
      ...(section.length > 0 ? [""] : [])
    );
  }
  if (opts.often && opts.often.length > 0) {
    body.push(`## ${OFTEN}`, "", ...opts.often, "");
  }
  const meta = { ...opts.meta, lines };
  const front = Object.entries(meta)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${front}\n---\n${body.join("\n").trimEnd()}\n`;
}

// --- where an observation lives ----------------------------------------------------------------------------------

/** What someone is like: about the owner alone, his, whatever its area. */
const PROFILE = new Set<Observation["type"]>(["about_a_person", "preference"]);

/**
 * The page an observation lives on, computed on every run and never stored: the page of who it is `about` (the owner, or
 * someone with a page) when extraction said so; else the person's page when it is about exactly one person (not the owner)
 * who has one, else the area page of its project (`Project.area`), else the owner's own when
 * it is about him alone (`unmapped`: it names someone Life can't map) and says what he is like or has no area, else its
 * own area, else none. Other pages may mention a fact; only its home says it.
 */
export function homePageOf(
  o: Pick<Observation, "about" | "area" | "entities" | "type"> & {
    unmapped: boolean;
  },
  truth: Pick<Truth, "projects">,
  paged: ReadonlySet<string>
) {
  if (o.about && (o.about === OWNER || paged.has(o.about))) {
    return o.about;
  }
  const people = othersIn(o.entities);
  const person = people.length === 1 ? people[0] : undefined;
  if (person && paged.has(person)) {
    return person;
  }
  for (const e of o.entities) {
    const area = truth.projects.find((p) => `project:${p.id}` === e)?.area;
    if (area) {
      return `area:${area}`;
    }
  }
  if (
    people.length === 0 &&
    o.entities.includes(OWNER) &&
    !o.unmapped &&
    (PROFILE.has(o.type) || !o.area)
  ) {
    return OWNER;
  }
  return o.area ? `area:${o.area}` : null;
}

/**
 * The page lines by home page (`homePageOf`), given who has a page (`paged`: the closeness levels, `pagedNow`). A
 * conditional claim (a hypothesis, a quote, an AI's text read aloud) stays searchable, never a page line.
 */
export function placed<T extends Observation & { unmapped: boolean }>(
  observations: T[],
  truth: Pick<Truth, "projects">,
  paged: ReadonlySet<string>
) {
  const lines = observations.filter(
    (o) => o.importance >= KEEP_AT && o.modality !== "conditional"
  );
  const homes = Map.groupBy(
    lines.flatMap((o) => {
      const home = homePageOf(o, truth, paged);
      return home ? [{ home, o }] : [];
    }),
    (h) => h.home
  );
  return { homes };
}

// --- merging the reply into the previous page --------------------------------------------------------------------

/**
 * What is new to a page since `seen` (its last reading, null for a page built from scratch): extracted since, or
 * refiled onto it since it was written (who it is about changed) and not offered to it yet.
 */
export function newOn<T extends Observation & { refiled: boolean }>(
  observations: T[],
  seen: Pick<PageMeta, "offered" | "seen"> | null
) {
  const offered = new Set(seen?.offered ?? []);
  return observations.filter(
    (o) =>
      !seen || o.madeBy.run > seen.seen || (o.refiled && !offered.has(o.id))
  );
}

/** What a page may cite: the observations homed on it and shown (retired included), and which of them are retired. */
export interface Known {
  byId: Map<string, Observation>;
  retired: Set<string>;
}

/** What `page` may cite of its observations: those that show there (`observationStatusOf`); a retired one stays cited, never new. */
export function knownOn(
  observations: Observation[],
  standing: ObservationStatusInputs,
  page: string
): Known {
  const shown = observations.flatMap((o) => {
    const s = observationStatusOf(o, standing);
    return shows(s, page) ? [{ o, retired: s.state === "retired" }] : [];
  });
  return {
    byId: new Map(shown.map(({ o }) => [o.id, o])),
    retired: new Set(
      shown.flatMap(({ o, retired }) => (retired ? [o.id] : []))
    ),
  };
}

const newestDate = (l: PageLine, k: Known) =>
  l.cites.reduce((m, id) => {
    const d = k.byId.get(id)?.date ?? "";
    return d > m ? d : m;
  }, "");

const dated = (l: PageLine, k: Known): PageLine => ({
  ...l,
  date: l.date ?? newestDate(l, k),
});

/**
 * The previous page's lines against what is true now. A line whose observations are all still shown stays word for
 * word. One that lost some (hidden by a correction, homed elsewhere, or replaced by a newer observation) keeps its live
 * cites and is flagged `changed`, so the model may rewrite it; one with none left is dropped, or moved to History
 * when its observations were only replaced.
 */
export function settle(prev: Sections, k: Known) {
  const out = perSection<PageLine>();
  const changed = new Set<string>();
  for (const { key } of SECTIONS) {
    const live = key !== "history";
    for (const l of prev[key]) {
      const alive = l.cites.filter((id) => k.byId.has(id));
      const current = alive.filter((id) => !k.retired.has(id));
      if (alive.length === 0) {
        continue;
      }
      if (current.length === 0 && live) {
        out.history.push(dated({ cites: alive, text: l.text }, k));
        continue;
      }
      // Whatever the model does with a flagged line, it rests on live observations only from here on.
      const kept = { ...l, cites: live ? current : alive };
      out[key].push(kept);
      if (
        live &&
        (alive.length < l.cites.length || current.length < alive.length)
      ) {
        changed.add(lineHash(renderLine(key, kept)));
      }
    }
  }
  return { changed, sections: out };
}

const Cited = z.object({
  cites: z.array(z.string()).default([]),
  text: z.string().min(1).max(400),
});
const Added = Cited.extend({
  section: PageSection.exclude(["history"]).default("now"),
});
const Past = Cited.extend({ date: z.iso.date() });
const Rewrite = Cited.extend({ line: z.string() });
export interface Check {
  /** Hashes of the live lines that are kept, and the ones among them whose cites changed. */
  changed: Set<string>;
  /** Observations the kept lines already rest on. */
  covered: Set<string>;
  /** The kept live lines by hash, with their section (`liveLines`). */
  current: ReturnType<typeof liveLines>;
  /** Ids given as new this run: only these can start a line, extend one or replace an older observation. */
  fresh: Set<string>;
  known: Known;
  /** This page's sections: where a new line may go. */
  layout: Layout;
  /** The words of the owner's lines: a new line may not repeat one. */
  owner: string[];
}

/** Why a well-formed new line can't stand, or false. `used`: observations already behind a line. */
const whyNot = (l: PageLine, c: Check, used: Set<string>, section: Key) =>
  (!hasSection(c.layout, section) && "section") ||
  (l.cites.length === 0 && "no-cite") ||
  (l.cites.some((id) => !c.known.byId.has(id)) && "unknown-cite") ||
  (l.cites.every((id) => c.known.retired.has(id)) && "retired") ||
  (!l.cites.some((id) => c.fresh.has(id)) && "not-new") ||
  (c.owner.includes(l.text) && "owner-line") ||
  (l.cites.every((id) => used.has(id)) && "repeat");

const items = (v: unknown) => z.array(z.unknown()).catch([]).parse(v);

/**
 * The consolidation reply, checked. The model may only: add a line to a live section (`now`) or a dated History line
 * (`past`) for new observations; move a kept line to History (`done`, by hash); rewrite a kept line whose cites changed
 * or that takes in new ones and keeps its own (`rewrite`, by hash). Code keeps any other line as it is. What is refused
 * is counted, not trusted. Retiring an observation is extraction's, where the evidence is (extract.ts).
 */
export function checkReply(reply: unknown, c: Check) {
  const body = z.record(z.string(), z.unknown()).parse(reply);
  const rejects: { reason: string; text: string }[] = [];
  const used = new Set(c.covered);
  const take = <T extends PageLine & { section?: Key }>(
    raws: unknown[],
    shape: z.ZodType<T>
  ) =>
    raws.flatMap((raw) => {
      const r = shape.safeParse(raw);
      if (!r.success) {
        rejects.push({ reason: "shape", text: JSON.stringify(raw) });
        return [];
      }
      const l = { ...r.data, cites: [...new Set(r.data.cites)] };
      const reason = whyNot(l, c, used, l.section ?? "history");
      if (reason) {
        rejects.push({ reason, text: l.text });
        return [];
      }
      for (const id of l.cites) {
        used.add(id);
      }
      return [l];
    });
  const add = take(items(body.now), Added);
  const past = take(items(body.past), Past);
  const done = items(body.done).flatMap((h) =>
    typeof h === "string" && c.current.has(h) ? [h] : []
  );
  const rewrite = new Map<string, PageLine>();
  const known = (id: string) =>
    c.known.byId.has(id) && !c.known.retired.has(id);
  for (const raw of items(body.rewrite)) {
    const r = Rewrite.safeParse(raw);
    const was = r.success ? c.current.get(r.data.line) : undefined;
    const cites = r.success ? [...new Set(r.data.cites)] : [];
    const added = cites.filter((id) => c.fresh.has(id) && !used.has(id));
    const grows =
      added.length > 0 && !!was?.line.cites.every((id) => cites.includes(id));
    if (!(r.success && was && (c.changed.has(r.data.line) || grows))) {
      rejects.push({ reason: "unchanged-line", text: JSON.stringify(raw) });
    } else if (cites.length === 0 || !cites.every(known)) {
      rejects.push({ reason: "bad-cite", text: r.data.text });
    } else {
      rewrite.set(r.data.line, { cites, text: r.data.text });
      for (const id of added) {
        used.add(id);
      }
    }
  }
  return { add, done, past, rejects, rewrite };
}

type Merge = ReturnType<typeof checkReply>;

/** Every kept live line by its hash, with its section: what `done` and `rewrite` may name. */
export const liveLines = (s: Sections) =>
  new Map(
    LIVE.flatMap(({ key }) =>
      s[key].map(
        (line) => [lineHash(renderLine(key, line)), { key, line }] as const
      )
    )
  );

/** Newest evidence first, then the words, so the same lines always come out in the same order. */
const byNewest = (k: Known) => (a: PageLine, b: PageLine) =>
  newestDate(b, k).localeCompare(newestDate(a, k)) ||
  a.text.localeCompare(b.text);
const byDay = (a: PageLine, b: PageLine) =>
  (b.date ?? "").localeCompare(a.date ?? "") || a.text.localeCompare(b.text);

/**
 * The next page: kept lines verbatim, plus what the reply added, finished or rewrote. Then code's rules: a live line
 * with no cited observation newer than its section's `ages` days ages into History (dated by its newest observation);
 * History is capped; the whole page fits its words by moving the oldest live lines to History and dropping the oldest
 * History. `fixed` is the words of what code cannot trim (hold, owner lines, Often talk about).
 */
export function assemble(
  settled: Sections,
  m: Merge,
  k: Known,
  opts: { fixed: number; layout: Layout; today: string }
): Sections {
  const out = perSection<PageLine>();
  for (const { key } of LIVE) {
    for (const l of settled[key]) {
      const h = lineHash(renderLine(key, l));
      // A section the page no longer has (he is no longer close) leaves its lines in History.
      if (m.done.includes(h) || !hasSection(opts.layout, key)) {
        out.history.push(dated(l, k));
      } else {
        out[key].push(m.rewrite.get(h) ?? l);
      }
    }
  }
  for (const { section, ...l } of m.add) {
    out[section].push(l);
  }
  out.history.push(...settled.history, ...m.past);
  const again = settle(out, k).sections;
  const aged = { ...again, history: [...again.history] };
  for (const { key, ...s } of opts.layout.live) {
    if (s.ages !== undefined) {
      const edge = daysBefore(opts.today, s.ages);
      const all = again[key];
      aged[key] = all.filter((l) => newestDate(l, k) >= edge);
      aged.history.push(
        ...all.filter((l) => newestDate(l, k) < edge).map((l) => dated(l, k))
      );
    }
  }
  return fit(aged, k, opts.fixed, opts.layout);
}

const sectionWords = (s: Sections) =>
  SECTIONS.reduce(
    (n, { key }) =>
      n + s[key].reduce((m, l) => m + wordsOf(renderLine(key, l)), 0),
    0
  );

/**
 * Sorts the sections and enforces the caps. The live sections may take all the page's words but HISTORY_ROOM: beyond
 * that, the line with the oldest evidence in a section that ages moves to History (one that never ages goes last).
 * History is cut to HISTORY_MAX lines, then oldest-first until the whole page fits.
 */
export function fit(
  s: Sections,
  k: Known,
  fixed: number,
  { live, words }: Layout
): Sections {
  const out = perSection<PageLine>();
  for (const { key } of live) {
    out[key] = [...s[key]].sort(byNewest(k));
  }
  let history = [...s.history];
  const lines = () =>
    live.flatMap((x) =>
      out[x.key].map((l) => ({ key: x.key, l, last: x.ages === undefined }))
    );
  while (
    lines().length > 1 &&
    fixed + sectionWords({ ...out, history: [] }) > words - HISTORY_ROOM
  ) {
    // A line of a section that ages before one that never does; then the oldest evidence; among equals, the last.
    const oldest = lines().reduce((a, b) =>
      (a.last === b.last ? newestDate(b.l, k) <= newestDate(a.l, k) : a.last)
        ? b
        : a
    );
    out[oldest.key] = out[oldest.key].filter((l) => l !== oldest.l);
    history.push(dated(oldest.l, k));
  }
  history = history.sort(byDay).slice(0, HISTORY_MAX);
  while (
    history.length > 0 &&
    fixed + sectionWords({ ...out, history }) > words
  ) {
    history.pop();
  }
  return { ...out, history };
}

/**
 * What changed between two versions of a page, in lines: `added` (words not on the page before), `moved` (a live line
 * now in History) and `removed` (words no longer on the page). An amended line is one removed and one added.
 */
export function changes(before: Sections, after: Sections) {
  const words = (s: Sections, keys: readonly Key[]) =>
    new Set(keys.flatMap((key) => s[key].map((l) => l.text)));
  const live = LIVE.map((x) => x.key);
  const was = words(before, [...live, "history"]);
  const is = words(after, [...live, "history"]);
  const count = (list: Set<string>, not: Set<string>) =>
    [...list].filter((t) => !not.has(t)).length;
  return {
    added: count(is, was),
    moved: [...words(after, ["history"])].filter(
      (t) => words(before, live).has(t) && !words(before, ["history"]).has(t)
    ).length,
    removed: count(was, is),
  };
}

/** The topics a person is often about, as one line: `ai (12), construction (9)`; none when no topic repeats. */
export function oftenLine(counts: Map<string, number>, top = 8) {
  const list = [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top);
  return list.length > 0
    ? [`- ${list.map(([t, n]) => `${t} (${n})`).join(", ")}`]
    : [];
}

/** A page file as a reader sees it: everything but its frontmatter. */
export const bodyOf = (text: string) => text.replace(FRONT, "").trim();

const SPACES = / +/g;
/** A name as a slug, how page files are named: "Money & admin" -> "money-admin". */
export const slugOf = (name: string) => normalize(name).replace(SPACES, "-");
