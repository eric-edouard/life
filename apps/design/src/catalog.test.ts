import { expect, test } from "bun:test";
import { filesIn, itemPathOf, itemsOf, pathsOf, readmeRowsOf } from "./catalog";

const README = `# Designs

## Approved

| Date | Design | What it is |
|---|---|---|
| 25 Nov 2026 | [App v4](2026-11-23-x/2026-11-25-app-v4.html) | The one approved design |

## Read first

| Date | Design | What it is |
|---|---|---|
| 26 Nov 2026 | [A lab](2026-11-23-x/2026-11-26-lab/index.html) | Under a heading that is no status |
`;

const PATHS = pathsOf([
  "docs/design/README.md",
  "docs/design/components.css",
  "docs/design/2026-11-23-x/2026-11-25-app-v4.html",
  "docs/design/2026-11-23-x/2026-11-26-lab/index.html",
  "docs/design/2026-11-23-x/2026-11-26-lab/pages.js",
  "docs/design/2026-11-23-x/2026-11-27-screens-turns/2026-11-27-one.png",
  "docs/design/2026-11-23-x/2026-11-27-turns.css",
  "docs/design/2026-11-23-x/2026-11-27-notes.md",
]);

test("a file belongs to its deepest dated folder or page; a dated screenshot to its folder", () => {
  expect(itemPathOf("2026-11-23-x/2026-11-26-lab/pages.js")).toBe(
    "2026-11-23-x/2026-11-26-lab/"
  );
  expect(
    itemPathOf("2026-11-23-x/2026-11-27-screens-turns/2026-11-27-one.png")
  ).toBe("2026-11-23-x/2026-11-27-screens-turns/");
  expect(itemPathOf("2026-11-23-x/2026-11-25-app-v4.html")).toBe(
    "2026-11-23-x/2026-11-25-app-v4.html"
  );
  expect(itemPathOf("README.md")).toBeUndefined();
});

test("items: pages, notes and dated folders, newest first, with the README's status only under a status heading", () => {
  const items = itemsOf(readmeRowsOf(README), PATHS);
  expect(items.map((i) => [i.path, i.kind, i.status, i.title])).toEqual([
    ["2026-11-23-x/2026-11-27-notes.md", "note", undefined, "Notes"],
    [
      "2026-11-23-x/2026-11-27-screens-turns/",
      "folder",
      undefined,
      "Screens turns",
    ],
    ["2026-11-23-x/2026-11-26-lab/", "folder", undefined, "Lab"],
    ["2026-11-23-x/2026-11-25-app-v4.html", "design", "Approved", "App v4"],
  ]);
  expect(filesIn(PATHS, "2026-11-23-x/2026-11-26-lab/")).toHaveLength(2);
});
