import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  agoOf,
  dateOf,
  filesIn,
  latestOf,
  newestCommitsOf,
  pathsOf,
  ROOT,
  tabsOf,
  unseenOf,
} from "./catalog";

const README = `# Designs

Some words, with a [link](x.md) that is no entry.

## Prototype

| Design | What it is |
|---|---|
| [App v4](2026-11-23-x/2026-11-25-app-v4.html) | The phone |
| [Rulebook](2026-11-23-x/2026-11-26-rules.md) | Its parts |

## Philosophy and guidelines

| Design | What it is |
|---|---|
| [Philosophy and guidelines](philosophy.md) | Every decision |

## Explorations

Proposals.

| Design | What it is |
|---|---|
| [Design lab](2026-11-23-x/2026-11-26-lab/index.html) | Variants |
`;

test("the README's sections are the tabs, each table row an entry dated by its file", () => {
  expect(
    tabsOf(README).map((t) => [
      t.title,
      t.entries.map((e) => [e.title, e.path, e.date, e.about]),
    ])
  ).toEqual([
    [
      "Prototype",
      [
        [
          "App v4",
          "2026-11-23-x/2026-11-25-app-v4.html",
          "2026-11-25",
          "The phone",
        ],
        [
          "Rulebook",
          "2026-11-23-x/2026-11-26-rules.md",
          "2026-11-26",
          "Its parts",
        ],
      ],
    ],
    [
      "Philosophy and guidelines",
      [
        [
          "Philosophy and guidelines",
          "philosophy.md",
          undefined,
          "Every decision",
        ],
      ],
    ],
    [
      "Explorations",
      [
        [
          "Design lab",
          "2026-11-23-x/2026-11-26-lab/index.html",
          "2026-11-26",
          "Variants",
        ],
      ],
    ],
  ]);
});

test("a path's date is its last dated segment's", () => {
  expect(dateOf("2026-11-23-x/2026-11-26-lab/index.html")).toBe("2026-11-26");
  expect(dateOf("philosophy.md")).toBeUndefined();
});

test("the files of a folder", () => {
  const paths = pathsOf([
    "docs/design/a/1.png",
    "docs/design/a/2.png",
    "docs/design/b.md",
  ]);
  expect(filesIn(paths, "a/")).toEqual(["a/1.png", "a/2.png"]);
});

test("the real README opens on a prototype, and every entry it lists exists", async () => {
  const tabs = tabsOf(await Bun.file(`${ROOT}README.md`).text());
  expect(
    tabs.find((t) => t.title === "Prototype")?.entries.length
  ).toBeGreaterThan(0);
  const missing = tabs
    .flatMap((t) => t.entries)
    .filter(({ path }) => !existsSync(`${ROOT}${path}`));
  expect(missing).toEqual([]);
});

test("each file's newest commit, from git log", () => {
  const log = "\x00300\n\na.html\n\x00200\n\na.html\nlab/x.css\n";
  expect(newestCommitsOf(log)).toEqual([
    ["a.html", 300],
    ["lab/x.css", 200],
  ]);
});

test("the latest changed entries: a folder's page by any file of its folder, newest first", () => {
  const entries = ["a.html", "lab/index.html", "b.md", "c.md", "never.md"].map(
    (path) => ({ about: "", path, title: path })
  );
  const commits: [string, number][] = [
    ["lab/x.css", 500],
    ["a.html", 300],
    ["b.md", 400],
    ["c.md", 100],
    ["labx.html", 900],
  ];
  expect(latestOf(entries, commits).map((l) => [l.entry.path, l.at])).toEqual([
    ["lab/index.html", 500],
    ["b.md", 400],
    ["a.html", 300],
  ]);
});

test("unseen: changed since last opened, a page never opened counts once it has a stamp", () => {
  const entries = ["a.html", "lab/index.html", "b.md", "never.md"].map(
    (path) => ({ about: "", path, title: path })
  );
  const stamps: [string, number][] = [
    ["a.html", 300],
    ["lab/x.css", 500],
    ["b.md", 400],
  ];
  const seen = { "a.html": 300, "lab/index.html": 200 };
  expect([...unseenOf(entries, stamps, seen)]).toEqual([
    "lab/index.html",
    "b.md",
  ]);
});

test("how long ago, short", () => {
  const now = 1_000_000_000_000;
  expect(agoOf(now / 1000 - 30, now)).toBe("just now");
  expect(agoOf(now / 1000 - 12 * 60, now)).toBe("12 min ago");
  expect(agoOf(now / 1000 - 2 * 3600 - 5, now)).toBe("2 h ago");
  expect(agoOf(now / 1000 - 3 * 86_400, now)).toBe("3 d ago");
});
