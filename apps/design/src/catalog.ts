// What docs/design holds, as the app lists it: each dated file or folder is one item, its status and words taken from
// docs/design/README.md's tables (the one list of what is approved), its date from its name.

import files from "virtual:design-files";
import { lexer, type Tokens } from "marked";

export const ROOT = "docs/design/";
export const README = "README.md";

export type Kind = "design" | "folder" | "note";
export type Status = "Approved" | "Proposals" | "Superseded" | "Tools";

export interface Item {
  about?: string;
  date: string;
  kind: Kind;
  /** Its path under docs/design: a file, or a folder ending in "/". */
  path: string;
  status?: Status;
  title: string;
}

const DATED = /^(\d{4}-\d{2}-\d{2})-(.+?)(\.(html|md))?$/;
export const SHOWN = /\.(html|md)$/;
const TRAILING_SLASH = /\/$/;

/** Every file under docs/design, relative to it. */
export const paths = (files as string[]).map((f) => f.slice(ROOT.length));

const titleOf = (name: string) => {
  const words = name.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const dateLabelOf = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** The last dated segment of a path: the item it belongs to ("2026-11-23-a/2026-11-26-lab/x.js" → "2026-11-23-a/2026-11-26-lab/"). */
export const itemPathOf = (path: string) => {
  const parts = path.split("/");
  const last = parts.length - 1;
  // A dated folder, or a dated page; a dated screenshot belongs to its folder.
  const at = parts.findLastIndex(
    (p, i) => DATED.test(p) && (i < last || SHOWN.test(p))
  );
  if (at < 0) {
    return;
  }
  return parts.slice(0, at + 1).join("/") + (at < parts.length - 1 ? "/" : "");
};

/** The README's tables: status, title and words for each item a row links. */
export const readmeRowsOf = (markdown: string) => {
  const rows = new Map<
    string,
    { about: string; status: Status; title: string }
  >();
  let status: Status | undefined;
  for (const token of lexer(markdown)) {
    if (token.type === "heading") {
      status = (token as Tokens.Heading).text as Status;
    }
    if (token.type !== "table" || !status) {
      continue;
    }
    for (const row of (token as Tokens.Table).rows) {
      const link = row[1]?.tokens.find(
        (t): t is Tokens.Link => t.type === "link"
      );
      const path = link && itemPathOf(link.href);
      if (path) {
        rows.set(path, { about: row[2]?.text ?? "", status, title: link.text });
      }
    }
  }
  return rows;
};

const kindOf = (item: string): Kind => {
  if (item.endsWith("/")) {
    return "folder";
  }
  return item.endsWith(".md") ? "note" : "design";
};

export const itemsOf = (readme: ReturnType<typeof readmeRowsOf>): Item[] => {
  const seen = new Map<string, Item>();
  for (const path of paths) {
    const item = itemPathOf(path);
    if (!item || seen.has(item) || !(item.endsWith("/") || SHOWN.test(item))) {
      continue;
    }
    const name = item.replace(TRAILING_SLASH, "").split("/").at(-1) ?? item;
    const [, date = "", rest = name] = DATED.exec(name) ?? [];
    const kind = kindOf(item);
    seen.set(item, {
      date,
      kind,
      path: item,
      title: titleOf(rest),
      ...readme.get(item),
    });
  }
  return [...seen.values()].sort(
    (a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title)
  );
};

/** The files directly inside a folder item, and the ones below it. */
export const filesIn = (folder: string) =>
  paths.filter((p) => p.startsWith(folder));

export const urlOf = (path: string) => `/${ROOT}${path}`;
