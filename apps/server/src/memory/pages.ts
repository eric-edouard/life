import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { appendJsonl } from "../core/files";
import { OWNER_DATA_DIR } from "../core/paths";
import { git } from "../core/proc";
import { stamp } from "../models/llm";
import {
  Correction,
  type InferredPerson,
  type Observation,
} from "../records/observation";
import type { Area, Person } from "../records/truth";
import type { Unit } from "../records/unit";
import { levelsWith, pagedBy, personallyClose, waitingOf } from "./closeness";
import {
  CORRECTIONS,
  PAGE_KINDS,
  PAGES,
  pagePath,
  readUnits,
  readVerdicts,
  type Standing,
  type Verdicts,
  verdictOf,
} from "./ledger";
import {
  assemble,
  bare,
  type Check,
  changes,
  checkReply,
  generated,
  knownOn,
  layoutOf,
  liveLines,
  newOn,
  oftenLine,
  ownerEdits,
  type PageLine,
  type PageMeta,
  type Parsed,
  parsePage,
  perSection,
  placed,
  renderPage,
  type Sections,
  settle,
  wordsOf,
} from "./page-format";
import { OWNER, type Truth } from "./read-truth";
import { begin, inBatches, refContext, type Step } from "./run";
import { daysBefore, slugOf, within } from "./units";
import { observationsNow, readPeople, type Shown, unitNow, who } from "./who";

// `bun life memory pages`: the pages step (docs/architecture.md, "The pipeline"). One page per person who has enough to
// say and per area. Each observation has one home page (`homeOf`). A page is rebuilt from its previous version: lines
// whose observations are unchanged stay word for word, the model only adds lines for new observations, finishes
// lines or fixes lines whose observations changed, and code ages lines into History and keeps the page within
// its word budget. Code checks every citation. Nothing is sent.

const PAGES_PROMPT = "memory-pages.v5";
/** Characters of observations per call; a new page over a busy area gets its newest ones. */
const BUDGET = 90_000;
const HOLD_MAX = 1500;
/** "Often talk about" counts the topics of the units of this many days. */
const OFTEN_DAYS = 90;
interface Target {
  /** Close to him personally: the page has Between us. */
  close: boolean;
  hold: string;
  name: string;
  /** Observations whose home is this page (importance 2+, replaced ones included), newest first. */
  observations: Shown[];
  path: string;
  ref: string;
}

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`.trimEnd())
    .join("\n");

function personHold(p: Person) {
  const facts = [
    p.relation,
    p.language && `speaks ${p.language}`,
    p.aliases.length > 0 && `also ${p.aliases.join(", ")}`,
    p.projects.length > 0 && `projects: ${p.projects.join(", ")}`,
  ].filter(Boolean);
  return `${quote(`**${p.name}** · ${facts.join(" · ")}`)}\n\n_From truth/people.yaml: yours. Life never edits it._`;
}

function ownerHold(me: Truth["me"]) {
  return `${quote(me.text.split("\n").slice(1).join("\n"))}\n\n_From truth/me.md: yours. Life never edits it._`;
}

function inferredHold(p: InferredPerson) {
  return `${quote(`**${p.name}** · ${p.relation}`)}\n\n_Inferred by Life from messages (confidence ${p.confidence}), not in truth/: it may be wrong. Tell Claude who this is and it is recorded._`;
}

function areaHold(a: Area, projects: Truth["projects"]) {
  if (projects.length === 0) {
    return "_Nothing about this area in truth/ yet._";
  }
  const each = projects.map((project) => {
    const head = [
      `**${project.name}** · ${project.status}`,
      ...project.deadlines.map((d) => `- ${d.date}: ${d.what}`),
      "",
      project.notes.trim(),
    ].join("\n");
    return head.length > HOLD_MAX
      ? `${head.slice(0, HOLD_MAX)}…`
      : head.trimEnd();
  });
  const files = projects.map((p) => `truth/projects/${p.id}.md`).join(", ");
  return `${quote(each.join("\n\n"))}\n\n_From ${files} (area ${a.name}): yours. Life never edits it._`;
}

async function readText(path: string) {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
}

const exists = (path: string) => Bun.file(path).exists();

/** Every page to keep: the owner's, a person with a page and something to say (or a file already), and every area. */
async function targets(
  observations: Shown[],
  truth: Truth,
  inferred: InferredPerson[],
  standing: Standing
) {
  const levels = levelsWith(standing.corrections);
  const paged = pagedBy(levels, await waitingOf(truth, standing.corrections));
  const close = personallyClose(levels);
  const { homes } = placed(observations, truth, paged);
  const newest = (ref: string) =>
    (homes.get(ref) ?? [])
      .map((h) => h.o)
      .sort((a, b) => b.at.localeCompare(a.at));
  const named = new Map<string, { hold: string; name: string }>([
    ...truth.people.map(
      (p) =>
        [
          `person:${p.id}`,
          {
            hold:
              `person:${p.id}` === OWNER ? ownerHold(truth.me) : personHold(p),
            name: p.name,
          },
        ] as const
    ),
    ...inferred.map(
      (p) =>
        [
          `person:${p.id}`,
          { hold: inferredHold(p), name: `${p.name} (inferred)` },
        ] as const
    ),
  ]);
  const people = await Promise.all(
    [...paged].map(async (ref): Promise<Target | null> => {
      const person = named.get(ref);
      const homed = newest(ref);
      return person && (homed.length > 0 || (await exists(pagePath(ref))))
        ? {
            ...person,
            close: close.has(ref),
            observations: homed,
            path: pagePath(ref),
            ref,
          }
        : null;
    })
  );
  const places = truth.areas.map(
    (a): Target => ({
      close: false,
      hold: areaHold(
        a,
        truth.projects.filter((p) => p.area === a.id)
      ),
      name: a.name,
      observations: newest(`area:${a.id}`),
      path: pagePath(`area:${a.id}`),
      ref: `area:${a.id}`,
    })
  );
  return {
    close,
    levels,
    targets: [...people.flatMap((t) => (t ? [t] : [])), ...places],
  };
}

interface BuiltPage {
  /** What the owner did to the page file, now recorded in corrections.jsonl. */
  corrections: Correction[];
  rejects: { reason: string; text: string }[];
  skipped: boolean;
  target: Target;
  text: string | null;
}

interface Run {
  at: string;
  /** The same for every call of a run, so the prompt cache hits: who the owner is, his people and areas. */
  context: unknown;
  /** Topic counts of units over the last 90 days, by person ref: "Often talk about". */
  often: (t: Target) => string[];
  rebuild: boolean;
  standing: Standing;
  step: Step;
  titles: Map<string, string>;
  today: string;
}

const asInput = (o: Observation, titles: Map<string, string>) => ({
  confidence: o.confidence,
  date: o.date,
  id: o.id,
  importance: o.importance,
  in: titles.get(o.unit) ?? null,
  quote: o.quote,
  text: o.text,
  type: o.type,
  when: o.when,
  who: who(o),
});

/** The owner's edits found on the page file now, as corrections not yet in corrections.jsonl. */
function newCorrections(ref: string, prev: Parsed, r: Run): Correction[] {
  const found = ownerEdits(prev);
  const have = new Set(
    r.standing.corrections.flatMap((c) =>
      c.kind === "keep-mine" && c.page === ref ? [bare(c.text)] : []
    )
  );
  const stamped = { at: r.at, schemaVersion: 1 as const };
  return [
    ...found.lines
      .filter((l) => !have.has(bare(l.text)))
      .map(
        (l): Correction => ({
          ...stamped,
          kind: "keep-mine",
          page: ref,
          section: l.section,
          text: l.text,
        })
      ),
    // A generated line he deleted (or rewrote: the old one is gone): its observations stay off this page.
    ...found.removed
      .filter((observations) => observations.length > 0)
      .map(
        (observations): Correction => ({
          ...stamped,
          kind: "not-important",
          observations,
          page: ref,
        })
      ),
  ];
}

async function buildOne(t: Target, r: Run, dir: string): Promise<BuiltPage> {
  const before = await readText(t.path);
  const prev = before ? parsePage(before) : null;
  const added = prev ? newCorrections(t.ref, prev, r) : [];
  const everything = [...r.standing.corrections, ...added];
  const known = knownOn(
    t.observations,
    { ...r.standing, corrections: everything },
    t.ref
  );
  const visible = t.observations.filter((o) => known.byId.has(o.id));
  // The owner's lines: those in the file, and the ones Claude recorded for him as `keep-mine`.
  const owner = [
    ...(prev ? ownerEdits(prev).lines : []),
    ...everything.flatMap((e) =>
      e.kind === "keep-mine" && e.page === t.ref
        ? [{ section: e.section, text: e.text }]
        : []
    ),
  ].filter(
    (l, i, all) => all.findIndex((x) => bare(x.text) === bare(l.text)) === i
  );
  const layout = layoutOf(t.ref, t.close);
  const old = prev && !r.rebuild ? generated(prev) : perSection<PageLine>();
  const settled = settle(old, known);
  const fresh = newOn(
    visible.filter((o) => !known.retired.has(o.id)),
    prev && !r.rebuild ? prev.meta : null
  );
  const refiled = visible.flatMap((o) => (o.refiled ? [o.id] : [])).sort();
  const seen = visible.reduce(
    (m, o) => (o.madeBy.run > m ? o.madeBy.run : m),
    prev && !r.rebuild ? prev.meta.seen : ""
  );
  const often = r.often(t);
  const fixed = [t.hold, ...often, ...owner.map((o) => o.text)].reduce(
    (n, x) => n + wordsOf(x),
    0
  );
  const base = {
    corrections: added,
    rejects: [],
    target: t,
  };
  const write = (page: Sections, by: PageMeta["madeBy"], built: string) =>
    renderPage({
      hold: t.hold,
      layout,
      meta: {
        built,
        madeBy: by,
        name: t.name,
        ...(refiled.length > 0 ? { offered: refiled } : {}),
        page: t.ref,
        schemaVersion: 1,
        seen,
      },
      often,
      owner,
      sections: page,
      title: t.name,
    });
  /** The page file, or null when it would be the same one (a quiet page keeps its file, and git stays quiet). */
  const finish = (page: Sections, by: PageMeta["madeBy"]) =>
    prev && write(page, prev.meta.madeBy, prev.meta.built) === before
      ? null
      : write(page, by, r.at);

  const current = liveLines(settled.sections);
  const check = (): Check => ({
    changed: settled.changed,
    covered: new Set(
      Object.values(settled.sections)
        .flat()
        .flatMap((l) => l.cites)
    ),
    current,
    fresh: new Set(fresh.map((o) => o.id)),
    known,
    layout,
    owner: owner.map((o) => bare(o.text)),
  });
  const cited = [...current].flatMap(([h, k]) =>
    settled.changed.has(h) ? [k.line] : []
  );
  if (fresh.length === 0 && cited.length === 0) {
    // Nothing new: no model. Lines still age into History and the budget still holds.
    const kept = assemble(settled.sections, checkReply({}, check()), known, {
      fixed,
      layout,
      today: r.today,
    });
    return {
      ...base,
      skipped: true,
      text: prev ? finish(kept, prev.meta.madeBy) : null,
    };
  }
  const c = check();
  const input = {
    cited: cited
      .flatMap((l) => l.cites)
      .filter((id, i, all) => all.indexOf(id) === i)
      .flatMap((id) => {
        const o = known.byId.get(id);
        return o ? [asInput(o, r.titles)] : [];
      }),
    existing: [...current].map(([line, { key, line: l }]) => ({
      changed: c.changed.has(line),
      cites: l.cites,
      line,
      section: key,
      text: l.text,
    })),
    // Newest first, within the character budget: what a new page is built from.
    observations: within(
      fresh.map((o) => asInput(o, r.titles)),
      BUDGET,
      (x) => JSON.stringify(x).length
    ),
    owner: owner.map((o) => bare(o.text)),
    page: { hold: t.hold, name: t.name, ref: t.ref },
    sections: layout.live,
    today: r.today,
  };
  const json = await r.step.ask({
    context: r.context,
    dir,
    input,
    prompt: PAGES_PROMPT,
  });
  // Only the observations the model was shown can start a line.
  const shown = new Set(input.observations.map((o) => o.id));
  const reply = checkReply(json, {
    ...c,
    fresh: new Set([...c.fresh].filter((id) => shown.has(id))),
  });
  await Bun.write(
    join(dir, "rejects.json"),
    JSON.stringify(reply.rejects, null, 1)
  );
  const sections = assemble(settled.sections, reply, known, {
    fixed,
    layout,
    today: r.today,
  });
  const madeBy = stamp(r.step.llm, PAGES_PROMPT, r.step.run);
  return {
    ...base,
    rejects: reply.rejects,
    skipped: false,
    text: finish(sections, madeBy),
  };
}

/** Deletes the page files no target claims any more (a person folded into another, a person who lost their page). */
export async function removeOrphans(dir: string, keep: Set<string>) {
  const found = await Promise.all(
    PAGE_KINDS.map(async (kind) =>
      (await readdir(join(dir, kind)).catch(() => []))
        .filter((name) => name.endsWith(".md"))
        .map((name) => join(dir, kind, name))
    )
  );
  const orphans = found.flat().filter((path) => !keep.has(path));
  // Read before they go: his edits on a page that leaves are still his (`pages` records them).
  const read = await Promise.all(
    orphans.map(async (path) => ({ path, text: await readText(path) }))
  );
  await Promise.all(orphans.map((path) => rm(path)));
  return read;
}

/**
 * For each person ref: the unit ids to count topics over (the units of their observations, the units they are in, as
 * of today: `unitNow`).
 */
function oftenBy(
  units: Unit[],
  verdicts: Verdicts,
  day: string,
  refOf: (ref: string) => string
) {
  const since = daysBefore(day, OFTEN_DAYS);
  const recent = units
    .filter((u) => !u.drop && u.date >= since && u.date <= day)
    .map((u) => unitNow(u, refOf));
  return (t: Target) => {
    // His page would count every unit: he is in all of them.
    if (!t.ref.startsWith("person:") || t.ref === OWNER) {
      return [];
    }
    const own = new Set(t.observations.map((o) => o.unit));
    const counts = new Map<string, number>();
    for (const u of recent) {
      if (u.people.includes(t.ref) || own.has(u.id)) {
        for (const topic of verdictOf(verdicts, u)?.topics ?? []) {
          counts.set(topic, (counts.get(topic) ?? 0) + 1);
        }
      }
    }
    return oftenLine(counts);
  };
}

interface PagesOptions {
  only?: string;
  rebuild?: boolean;
}

/** `bun life memory pages`. Its callers hold the memory lock (`locked`, memory-lock.ts); the nightly commits what it writes. */
export async function pages(opts: PagesOptions) {
  const step = await begin("pages", "main", { prompt: PAGES_PROMPT });
  const { now, today: day } = step;

  const [people, units, verdicts] = await Promise.all([
    readPeople(),
    readUnits(),
    readVerdicts(),
  ]);
  const { inferred, truth } = people;
  const current = await observationsNow(people);
  const {
    close,
    levels,
    targets: all,
  } = await targets(current.observations, truth, inferred, current.standing);
  const context = refContext(truth, inferred, close);
  const { only } = opts;
  const chosen = only
    ? all.filter(
        (t) =>
          t.ref === `person:${only}` ||
          t.ref === `area:${only}` ||
          slugOf(t.name) === slugOf(only)
      )
    : all;
  const r: Run = {
    at: now.toISOString(),
    context,
    often: oftenBy(units, verdicts, day, people.refOf),
    rebuild: opts.rebuild ?? false,
    standing: current.standing,
    step,
    titles: new Map(units.map((u) => [u.id, u.title])),
    today: day,
  };
  const built: BuiltPage[] = [];
  // One bad page keeps its previous version; the next run tries again.
  await inBatches(chosen, step.dir, (t, bdir) =>
    step.attempt(
      async () => {
        built.push(await buildOne(t, r, bdir));
      },
      { page: t.ref }
    )
  );
  built.sort((a, b) => a.target.name.localeCompare(b.target.name));

  await Promise.all(
    built.map(async ({ target, text }) => {
      if (text) {
        await mkdir(join(target.path, ".."), { recursive: true });
        await Bun.write(target.path, text);
      }
    })
  );
  // A page no one keeps any more (a person no longer close, an area gone) leaves, his edits on it recorded first; git
  // keeps it. The report names them and why.
  const gone = (
    only ? [] : await removeOrphans(PAGES, new Set(all.map((t) => t.path)))
  ).flatMap(({ text }) => {
    const parsed = text ? parsePage(text) : null;
    return parsed ? [parsed] : [];
  });
  await appendJsonl(CORRECTIONS, Correction, [
    ...built.flatMap((b) => b.corrections),
    ...gone.flatMap((g) => newCorrections(g.meta.page, g, r)),
  ]);
  return {
    dropped: gone.map(
      (g) =>
        `${g.meta.name} (${levels.get(g.meta.page)?.why ?? (g.meta.page.startsWith("area:") ? "its area is gone" : "no longer known")})`
    ),
    ...step.end({
      corrections: built.reduce((n, b) => n + b.corrections.length, 0),
      pages: built.length,
      rejects: built.reduce((n, b) => n + b.rejects.length, 0),
      skipped: built.filter((b) => b.skipped).length,
    }),
    /** Per page that changed since the last commit (the last night): lines added, moved to History and removed. */
    changes: changedSinceCommit(),
  };
}

/**
 * Each page that changed since `~/Life`'s last commit (the night's), midday runs' rewrites included, against its
 * committed version: lines added, moved to History and removed. A page gone counts its lines removed.
 */
export function changedSinceCommit(root = OWNER_DATA_DIR, dir = PAGES) {
  if (git(root, ["rev-parse", "--git-dir"]).exitCode !== 0) {
    throw new Error(`${root} is not a git repository`);
  }
  const at = relative(root, dir);
  // Every page committed (none before the first commit) and every page now, as git names them (always with `/`): a
  // page new or gone counts too.
  const list = (args: string[]) =>
    git(root, [...args, "-z", "--", at])
      .stdout.toString()
      .split("\0");
  const committed = list(["ls-tree", "-r", "--name-only", "HEAD"]);
  const now = list(["ls-files", "--cached", "--others"]);
  const paths = [...new Set([...committed, ...now])].filter((p) =>
    p.endsWith(".md")
  );
  return paths.flatMap((path) => {
    const head = git(root, ["show", `HEAD:${path}`]);
    const was = parsePage(head.exitCode === 0 ? head.stdout.toString() : "");
    const file = join(root, path);
    const is = existsSync(file) ? parsePage(readFileSync(file, "utf8")) : null;
    const name = is?.meta.name ?? was?.meta.name;
    const c = changes(
      was ? generated(was) : perSection(),
      is ? generated(is) : perSection()
    );
    return name && c.added + c.moved + c.removed > 0
      ? [{ page: name, ...c }]
      : [];
  });
}
