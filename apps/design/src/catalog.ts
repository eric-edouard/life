// What the designs app lists: docs/design/README.md's sections are its tabs, in order, and each row of a section's table
// is an entry under it (the one index; a file the README doesn't list is still reachable by its links, never in the list).
// An entry's date is its file's (`YYYY-MM-DD-…`).

import { lexer, type Tokens } from "marked";

export const ROOT = "docs/design/";

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
