// What the designs app lists: docs/design/README.md's sections are its tabs, in order, and each row of a section's table
// is an entry under it (the one index; a file the README doesn't list is still reachable by its links, never in the list).
// An entry's date is its file's (`YYYY-MM-DD-…`).

import { lexer, type Tokens } from "marked";

export const ROOT = "docs/design/";
/** Where the designs app asks when each design file last changed (`readChangeStamps` in vite.config.ts). */
export const STAMPS_URL = "/__design-stamps";

export interface Entry {
  about: string;
  date?: string;
  /** Its path under docs/design. */
  path: string;
  title: string;
}

export interface Tab {
  entries: Entry[];
  title: string;
}

const DATED = /^(\d{4}-\d{2}-\d{2})-/;
export const SHOWN = /\.(html|md)$/;

/** Repo paths of docs/design's files, made relative to it. */
export const pathsOf = (files: string[]) =>
  files.map((f) => f.slice(ROOT.length));

export const dateLabelOf = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** The date of a path: its last dated segment's ("2026-11-23-a/2026-11-26-lab/index.html" → "2026-11-26"). */
export const dateOf = (path: string) =>
  path
    .split("/")
    .map((p) => DATED.exec(p)?.[1])
    .findLast(Boolean);

/** The README's sections as tabs: each `##` heading, with the rows of the table under it. */
export const tabsOf = (markdown: string): Tab[] => {
  const tabs: Tab[] = [];
  for (const token of lexer(markdown)) {
    if (token.type === "heading" && (token as Tokens.Heading).depth === 2) {
      tabs.push({ entries: [], title: (token as Tokens.Heading).text });
    }
    const tab = tabs.at(-1);
    if (token.type !== "table" || !tab) {
      continue;
    }
    for (const row of (token as Tokens.Table).rows) {
      const link = row[0]?.tokens.find(
        (t): t is Tokens.Link => t.type === "link"
      );
      if (link) {
        tab.entries.push({
          about: row[1]?.text ?? "",
          date: dateOf(link.href),
          path: link.href,
          title: link.text,
        });
      }
    }
  }
  return tabs;
};

/** The files at and below a path. */
export const filesIn = (paths: string[], folder: string) =>
  paths.filter((p) => p.startsWith(folder));

export const urlOf = (path: string) => `/${ROOT}${path}`;

/** A variation of a component in docs/design/components.json. */
export interface Variation {
  name: string;
  on?: string;
  /** Another design page to draw instead of the prototype, its state in the hash when it takes one. */
  page?: string;
  /** The part of the phone it draws, the latest match; none: the whole phone. */
  part?: string;
  row: string | null;
  scene?: string[];
  status: string;
  /** Drawn across the whole row (a page wider than the phone). */
  wide?: boolean;
}

/** Each file's newest commit, from `git log --format=%x00%ct --name-only`: [repo path, unix seconds], newest first. */
export const newestCommitsOf = (log: string): [string, number][] => {
  const newest = new Map<string, number>();
  for (const commit of log.split("\0").slice(1)) {
    const [time, ...files] = commit.split("\n");
    for (const file of files) {
      if (file && !newest.has(file)) {
        newest.set(file, Number(time));
      }
    }
  }
  return [...newest];
};

/** An entry's folder when it is a folder's page (`…/index.html`), so any file of it counts as a change to it. */
const changedUnder = (path: string) =>
  path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path;

/** When a page last changed (unix seconds; 0 when nothing dates it): its files' newest stamp, from
 *  `readChangeStamps` in vite.config.ts as [path under docs/design, unix seconds]. */
export const changedAtOf = (path: string, stamps: [string, number][]) => {
  const under = changedUnder(path);
  return Math.max(
    0,
    ...stamps
      .filter(([p]) => (under === path ? p === under : p.startsWith(under)))
      .map(([, t]) => t)
  );
};

/** The entries changed most recently, newest first. */
export const latestOf = (
  entries: Entry[],
  stamps: [string, number][],
  count = 3
) =>
  entries
    .map((entry) => ({ at: changedAtOf(entry.path, stamps), entry }))
    .filter((e) => e.at > 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, count);

/** The paths that changed since the viewer last opened them (`seen`: path → the stamp it had then). */
export const unseenOf = (
  entries: Entry[],
  stamps: [string, number][],
  seen: Record<string, number>
) =>
  new Set(
    entries
      .filter((e) => changedAtOf(e.path, stamps) > (seen[e.path] ?? 0))
      .map((e) => e.path)
  );

/** What was seen after opening a page, or null when nothing changes (no stamps yet, or already seen at its stamp).
 *  The first visit (`seen` null) records every entry's stamp, so only changes made after it show. */
export const seenAfter = (
  seen: Record<string, number> | null,
  entries: Entry[],
  stamps: [string, number][],
  opened: string
) => {
  const at = changedAtOf(opened, stamps);
  if (stamps.length === 0 || seen?.[opened] === at) {
    return null;
  }
  return {
    ...(seen ??
      Object.fromEntries(
        entries.map((e) => [e.path, changedAtOf(e.path, stamps)])
      )),
    [opened]: at,
  };
};

/** How long ago a time was, short: "just now", "12 min ago", "2 h ago", "3 d ago". */
export const agoOf = (seconds: number, now = Date.now()) => {
  const minutes = Math.floor((now / 1000 - seconds) / 60);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
};
