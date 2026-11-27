import { expect, test } from "bun:test";
import { dateOf, filesIn, pathsOf, tabsOf } from "./catalog";

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
