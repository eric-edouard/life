import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { clock, DAY } from "../core/clock";
import { log } from "../core/log";
import { exec, git } from "../core/proc";
import { expand, settings } from "../core/settings";
import type { InferredRepo } from "../records/observation";
import type { SourceEvent } from "../records/source";
import type { Person, Project } from "../records/truth";
import type { Newest, RepoMap } from "./contract";

// Git commits as a source: local `git log` of every repo in the `repos` setting's folder, read-only. A repo-day is a
// unit like a chat-day.

/** The folder holding his repos; none set, there are none. */
const work = () => {
  const folder = settings().repos;
  return folder && expand(folder);
};
const RS = "\x1e";
const US = "\x1f";
// Lockfiles and single-file changes this big are generated: they would drown the real work in the line counts.
const LOCK =
  /(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Podfile\.lock|Gemfile\.lock|poetry\.lock|uv\.lock)$/;
// ponytail: a 3,000-line single-file change counts as generated; a per-repo ignore list if real rewrites go missing
const GENERATED = 3000;

export interface Repo {
  /** The main worktree's folder name: all worktrees of a repo are one key. */
  key: string;
  path: string;
}

/** The repos under `root`: a folder with a `.git`, worktrees folded into their main repo by the common git dir. */
export function listRepos(root = work()): Repo[] {
  if (!root) {
    return [];
  }
  const repos = new Map<string, Repo>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(root, entry.name);
    const dot = statSync(join(dir, ".git"), { throwIfNoEntry: false });
    const common = dot?.isDirectory()
      ? join(dir, ".git")
      : git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
          .stdout.toString()
          .trim();
    if (dot && common) {
      const path = basename(common) === ".git" ? dirname(common) : common;
      repos.set(basename(path), { key: basename(path), path });
    }
  }
  return [...repos.values()];
}

/** The earliest author timestamp across local repos, without subjects or file changes. */
export function readEarliestCommit(root = work()) {
  const times = listRepos(root).flatMap(({ path }) => {
    const out = git(path, ["log", "--all", "--no-merges", "--format=%aI"]);
    if (out.exitCode !== 0) {
      throw new Error(out.stderr.toString().trim());
    }
    return out.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Date.parse);
  });
  return times.length > 0
    ? new Date(times.reduce((a, b) => Math.min(a, b))).toISOString()
    : null;
}

/** The newest commit in any repo, and how many repos had one in the last day (the status snapshot). */
export async function newestCommit(now = clock().getTime()): Promise<Newest> {
  const all = await Promise.all(
    listRepos().map(async (r) => ({
      at: (
        await exec(
          ["git", "-C", r.path, "log", "-1", "--all", "--format=%cI"],
          { timeout: 10_000 }
        )
      ).stdout.trim(),
      repo: r.key,
    }))
  );
  const dated = all
    .filter((r) => r.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const day = dated.filter((r) => now - Date.parse(r.at) < DAY).length;
  return {
    at: dated[0] ? new Date(dated[0].at).toISOString() : null,
    facts: [
      { label: "Repo", value: dated[0]?.repo ?? "?" },
      { label: "Repos with commits in a day", value: String(day) },
    ],
  };
}

/** The repo map: truth first, in his order (a project's first repo is its main one), then what Life inferred for the rest. */
export function repoMap(
  truth: { projects: Project[] },
  inferredRepos: InferredRepo[]
): RepoMap {
  const map: RepoMap = new Map();
  for (const p of truth.projects) {
    for (const repo of p.repos) {
      map.set(repo, { area: p.area, project: p.id });
    }
  }
  for (const g of inferredRepos) {
    if (!map.has(g.repo)) {
      map.set(g.repo, { area: g.area, inferred: g, project: g.project });
    }
  }
  return map;
}

/** `git log` options for his commits: by any of his emails in truth, or his name (`me`, the owner), in any case. */
const mine = (me: Person) => [
  "--regexp-ignore-case",
  ...[...me.handles.email, me.name].map((a) => `--author=${a}`),
];
const isMine = (me: Person, email: string, name: string) =>
  name.toLowerCase() === me.name.toLowerCase() ||
  me.handles.email.some((e) => e.toLowerCase() === email.toLowerCase());
const SUBJECTS = 8;

/** His commits in a repo, all time: how many, the first and last day, and the latest subjects. */
export function myCommits(path: string, me: Person) {
  const commits = git(path, [
    "log",
    "--all",
    "--no-merges",
    ...mine(me),
    `--format=%aI${US}%s`,
  ])
    .stdout.toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(US) as [string, string]);
  return {
    count: commits.length,
    first: commits.at(-1)?.[0].slice(0, 10),
    last: commits[0]?.[0].slice(0, 10),
    subjects: commits.slice(0, SUBJECTS).map(([, subject]) => subject),
  };
}

/**
 * The commits in a `git log --numstat` of `key`, authored at or after `since` (git's own --since is the committer date),
 * each once (`seen`: the shas already taken, by this log or an earlier repo's). Lines count without lockfiles, binary
 * files and generated-size changes.
 */
export function parseLog(
  out: string,
  key: string,
  since: Date,
  me: Person,
  seen = new Set<string>(),
  before?: Date
): SourceEvent[] {
  return out
    .split(RS)
    .slice(1)
    .flatMap((chunk) => {
      const [head = "", ...stat] = chunk.split("\n");
      const [sha = "", at = "", email = "", name = "", subject = ""] =
        head.split(US);
      if (
        seen.has(sha) ||
        new Date(at) < since ||
        (before && new Date(at) >= before)
      ) {
        return [];
      }
      seen.add(sha);
      let added = 0;
      let removed = 0;
      for (const line of stat) {
        const [a, d, file = ""] = line.split("\t");
        const [x, y] = [Number(a), Number(d)];
        // A binary file shows "-" (NaN); a blank line has no second number.
        if (x >= 0 && y >= 0 && !LOCK.test(file) && x + y <= GENERATED) {
          added += x;
          removed += y;
        }
      }
      const fromMe = isMine(me, email, name);
      return [
        {
          added,
          at: new Date(at).toISOString(),
          chat: key,
          chatName: key,
          fromMe,
          id: `git:${key}/${sha}`,
          removed,
          sender: fromMe ? "me" : name,
          source: "git" as const,
          text: subject,
        },
      ];
    });
}

/**
 * Every commit since `since` in every repo of `root`, all branches, no merges: his in any repo, other authors' too in
 * the ones mapped to a project. A commit in two clones of one repo counts once, in the first that has it: a repo mapped
 * to a project before one that isn't, then by key. A repo whose log fails is logged and skipped; an unreadable `root`
 * throws.
 * ponytail: a rebased commit already pushed can count twice (an old sha stays on a remote-tracking ref); every repo is
 * scanned even when only one unit is wanted (`fetch`).
 */
export function readGit(
  since: Date,
  repos: RepoMap,
  me: Person,
  root = work(),
  before?: Date
): SourceEvent[] {
  const seen = new Set<string>();
  const mapped = (key: string) => Boolean(repos.get(key)?.project);
  const ordered = listRepos(root).toSorted(
    (a, b) =>
      Number(mapped(b.key)) - Number(mapped(a.key)) ||
      a.key.localeCompare(b.key)
  );
  return ordered.flatMap(({ key, path }) => {
    const out = git(path, [
      "log",
      "--all",
      "--no-merges",
      ...(mapped(key) ? [] : mine(me)),
      `--since=${since.toISOString()}`,
      ...(before ? [`--until=${before.toISOString()}`] : []),
      "--numstat",
      `--format=${RS}%H${US}%aI${US}%ae${US}%an${US}%s`,
    ]);
    if (out.exitCode !== 0) {
      log("run.error", {
        error: out.stderr.toString().trim(),
        repo: key,
        step: "source.git",
      });
      return [];
    }
    return parseLog(out.stdout.toString(), key, since, me, seen, before);
  });
}
