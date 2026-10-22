import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { clock } from "../clock";
import { stamp } from "../llm";
import { HOME } from "../platform";
import { redact } from "../redact";
import { type MadeBy, RepoGuess, type Unit } from "../schema";
import { kindOf } from "../sources";
import {
  listRepos,
  myCommits,
  type Placement,
  type RepoMap,
  readGit,
  repoMap,
} from "../sources/git";
import { loadTruth, ownerIn } from "../truth";
import {
  appendJsonl,
  REPOS_INFERRED,
  readRepoGuesses,
  readUnits,
  readVerdicts,
  type Verdicts,
  verdictOf,
} from "./ledger";
import { topTopics } from "./moments";
import { asData } from "./raw";
import { begin, checkedEntries, chunks, inBatches, meContext } from "./run";
import { areaLookup, areaOf, clip, lineCounts } from "./units";
import { localDate } from "./zones";

// `bun life memory repos --scan` and the nightly's first step: which project each code repo of the owner's belongs to. His
// map is `Project.repos` in truth/; for the repos it doesn't list, the fast-tier model guesses from what the repo says
// about itself (memory/repos-inferred.jsonl, used at once below truth/). Only repos with his commits are asked about,
// so upstream clones never are; a repo is asked about once per prompt version.

const REPOS_PROMPT = "repos.v1";
const PER_CALL = 20;
const README_FILES = ["README.md", "AGENTS.md", "CLAUDE.md"];
const README_MAX = 600;
const NOTES_MAX = 200;
const DAY_MS = 86_400_000;

const Entry = z.object({
  area: z.string().nullish(),
  key: z.string(),
  newProject: z.string().min(1).nullish(),
  project: z.string().nullish(),
  why: z.string().min(1),
});

/**
 * The model's reply for one call: a record for each repo we asked about (`asked`), once. A project that is not the owner's
 * becomes null (counted); a repo on a project takes the project's area, else the area is looked up (id or name).
 * Anything else is counted as invalid, never trusted.
 */
export function parseGuesses(
  reply: unknown,
  asked: Set<string>,
  ctx: {
    areas: Map<string, string>;
    at: string;
    madeBy: MadeBy;
    /** Project id -> its area. */
    projects: Map<string, string>;
  }
) {
  const list = z.object({ repos: z.array(z.unknown()) }).parse(reply).repos;
  const { entries, invalid } = checkedEntries(
    list,
    Entry,
    (e) => e.key,
    (key) => asked.has(key)
  );
  let unknownProject = 0;
  const records = entries.map(
    ({ key, area, newProject, project, why }): RepoGuess => {
      const ofProject = project ? ctx.projects.get(project) : undefined;
      if (project && ofProject === undefined) {
        unknownProject += 1;
      }
      return {
        area: ofProject ?? areaOf(area ?? null, ctx.areas),
        at: ctx.at,
        madeBy: ctx.madeBy,
        newProject: ofProject === undefined ? (newProject ?? null) : null,
        project: ofProject === undefined ? null : (project ?? null),
        repo: key,
        schemaVersion: 1,
        why: clip(why, 300),
      };
    }
  );
  return { invalid, records, unknownProject };
}

function readme(path: string) {
  const file = README_FILES.map((n) => join(path, n)).find(existsSync);
  return file && redact(readFileSync(file, "utf8").slice(0, README_MAX));
}

export async function mapRepos() {
  const step = await begin("repos", "fast", { prompt: REPOS_PROMPT });
  const [truth, guesses] = await Promise.all([loadTruth(), readRepoGuesses()]);
  // Listed in truth, or asked about under this prompt already (however unsure the answer): not asked again.
  const known = new Set([
    ...repoMap(truth, []).keys(),
    ...guesses
      .filter((g) => g.madeBy.prompt === REPOS_PROMPT)
      .map((g) => g.repo),
  ]);

  const candidates = listRepos()
    .filter((r) => !known.has(r.key))
    .flatMap((r) => {
      const mine = myCommits(r.path, ownerIn(truth.people));
      return mine.count === 0
        ? []
        : [{ ...mine, key: r.key, readme: readme(r.path) }];
    });

  const ctx = {
    areas: areaLookup(truth.areas),
    at: step.now.toISOString(),
    madeBy: stamp(step.llm, REPOS_PROMPT, step.run),
    projects: new Map(truth.projects.map((p) => [p.id, p.area])),
  };
  const context = {
    ...meContext(truth),
    projects: truth.projects.map((p) => ({
      area: p.area,
      id: p.id,
      name: p.name,
      notes: clip(p.notes, NOTES_MAX),
      repos: p.repos,
    })),
  };
  const made: RepoGuess[] = [];
  let invalid = 0;
  let unknownProject = 0;
  // One bad call costs only its repos: they are asked again next time.
  await inBatches(chunks(candidates, PER_CALL), step.dir, (batch, dir) =>
    step.attempt(async () => {
      const json = await step.ask({
        context,
        dir,
        input: { repos: batch },
        prompt: REPOS_PROMPT,
      });
      const checked = parseGuesses(json, new Set(batch.map((c) => c.key)), ctx);
      // Written as each call ends: a stopped run resumes from them.
      await appendJsonl(REPOS_INFERRED, RepoGuess, checked.records);
      made.push(...checked.records);
      invalid += checked.invalid;
      unknownProject += checked.unknownProject;
    })
  );
  return step.end({
    candidates: candidates.length,
    invalid,
    mapped: made.filter((g) => g.project).length,
    /** Repos that fit no project but look like one he might want, as this run guessed them. */
    suggestions: made.flatMap((g) =>
      g.newProject
        ? [{ area: g.area, newProject: g.newProject, repo: g.repo }]
        : []
    ),
    unknownProject,
  });
}

const commits = (units: Unit[]) => units.reduce((n, u) => n + u.stats.items, 0);
const THEMES = 3;

/** "photo-app 15 (Jérôme 12)": a repo-day's commits, with other authors' first names. */
function repoText(u: Unit) {
  const by = Object.entries(u.stats.others ?? {})
    .map(([name, n]) => `${name.split(" ")[0]} ${n}`)
    .join(", ");
  return `${u.key} ${u.stats.items}${by ? ` (${by})` : ""}`;
}

/**
 * The report's Code rows for one day's git units (one per repo): one row per project (else "Other repos"), busiest
 * first: its repos by commits, lines, and the three most frequent topics the verdicts gave the units.
 */
export function codeRows(
  units: Unit[],
  verdicts: Verdicts,
  map: RepoMap,
  projects: { id: string; name: string }[]
) {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return [...Map.groupBy(units, (u) => map.get(u.key)?.project ?? "")]
    .sort(([, a], [, b]) => commits(b) - commits(a))
    .map(([project, list]) => ({
      name: names.get(project) ?? "Other repos",
      relation: [
        list
          .toSorted((a, b) => b.stats.items - a.stats.items)
          .map(repoText)
          .join(", "),
        lineCounts(list.map((u) => u.stats)),
        topTopics(
          list.flatMap((u) => verdictOf(verdicts, u) ?? []),
          THEMES
        ).join(", "),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
}

/** The Code rows for one day's git units, as the moments step wrote them. */
export async function codeOn(day: string) {
  const [truth, guesses, units, verdicts] = await Promise.all([
    loadTruth(),
    readRepoGuesses(),
    readUnits(),
    readVerdicts(),
  ]);
  return codeRows(
    units.filter((u) => kindOf(u.source) === "repo" && u.date === day),
    verdicts,
    repoMap(truth, guesses),
    truth.projects
  );
}

const ACTIVE_DAYS = 30;
const SUGGESTION_MAX = 100;

/**
 * `bun life memory repos [project|area|repo]`: the repos on his map, by project, with where they are and the last 30 days
 * of commits (local, a few seconds). Repos not on the map (upstream clones) are not shown.
 */
export async function reposOf(filter?: string) {
  const [truth, guesses] = await Promise.all([loadTruth(), readRepoGuesses()]);
  const map = repoMap(truth, guesses);
  const local = new Map(listRepos().map((r) => [r.key, r.path]));
  const active = new Map<string, { last: string; n: number }>();
  for (const e of readGit(
    new Date(clock().getTime() - ACTIVE_DAYS * DAY_MS),
    map,
    ownerIn(truth.people)
  )) {
    const day = localDate(e.at);
    const seen = active.get(e.chat);
    active.set(e.chat, {
      last: seen && seen.last > day ? seen.last : day,
      n: (seen?.n ?? 0) + 1,
    });
  }
  const f = filter?.toLowerCase();
  // Life's guesses only for repos cloned here (its first run also guessed at GitHub-only ones).
  const wanted = [...map].filter(
    ([key, r]) =>
      (local.has(key) || !r.guess) &&
      (!f ||
        key.toLowerCase().includes(f) ||
        [r.project, r.area].some((x) => x?.toLowerCase() === f))
  );
  const line = (key: string, r: Placement) => {
    const path = local.get(key);
    const first =
      truth.projects.find((p) => p.id === r.project)?.repos[0] === key;
    const seen = active.get(key);
    const tags = [
      !path && "not cloned",
      r.guess && "inferred",
      r.guess?.newProject &&
        `new project? ${clip(r.guess.newProject, SUGGESTION_MAX)}`,
    ].filter(Boolean);
    return `${path ? path.replace(HOME, "~") : key}${first ? " (main)" : ""}${tags.length > 0 ? ` (${tags.join("; ")})` : ""} · ${seen ? `${seen.n} commits, last ${seen.last}` : "no commits"}`;
  };
  const groups = [
    ...Map.groupBy(wanted, ([, r]) => r.project ?? `~${r.area ?? ""}`),
  ].sort(([a], [b]) => a.localeCompare(b));
  return asData([
    `Repos by project (truth = his map; inferred = Life's guess), with commits of the last ${ACTIVE_DAYS} days. Read the first repo's AGENTS.md or README first.`,
    ...(groups.length === 0 ? ["(no repo matches)"] : []),
    ...groups.map(([project, list]) => {
      const area = list[0]?.[1].area ?? "no area";
      const name = project.startsWith("~")
        ? `no project · ${area}`
        : `${project} (${area})`;
      return `${name}: ${list.map(([key, r]) => line(key, r)).join("; ")}`;
    }),
  ]);
}
