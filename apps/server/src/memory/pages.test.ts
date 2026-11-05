import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../core/proc";
import { layoutOf, renderPage } from "./page-format";
import { changedSinceCommit, removeOrphans } from "./pages";

test("pages no target claims are deleted, the others stay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pages-"));
  await mkdir(join(dir, "people"));
  await mkdir(join(dir, "areas"));
  await Promise.all(
    ["people/zoe.md", "people/inf_anais.md", "areas/shop.md"].map((f) =>
      Bun.write(join(dir, f), "x")
    )
  );
  const keep = new Set([
    join(dir, "people/zoe.md"),
    join(dir, "areas/shop.md"),
  ]);
  // Read before they go, so his edits on them can be kept.
  expect(await removeOrphans(dir, keep)).toEqual([
    { path: join(dir, "people/inf_anais.md"), text: "x" },
  ]);
  expect(await readdir(join(dir, "people"))).toEqual(["zoe.md"]);
  expect(await readdir(join(dir, "areas"))).toEqual(["shop.md"]);
  await rm(dir, { recursive: true });
});

test("what changed is counted against the last commit, so a hand run's rewrite shows in the night's report; a page new or gone too", async () => {
  const root = await mkdtemp(join(tmpdir(), "life-"));
  const dir = join(root, "memory", "pages");
  await mkdir(join(dir, "people"), { recursive: true });
  const page = (name: string, lines: string[]) =>
    renderPage({
      hold: "",
      layout: layoutOf(`person:${name.toLowerCase()}`),
      meta: {
        built: "2026-10-20T00:00:00.000Z",
        madeBy: { engine: "claude", model: "m", prompt: "p", run: "r" },
        name,
        page: `person:${name.toLowerCase()}`,
        schemaVersion: 1,
        seen: "r",
      },
      owner: [],
      sections: {
        bond: [],
        health: [],
        history: [],
        now: lines.map((text) => ({ cites: ["obs_aaaaaaaaaaaa"], text })),
        views: [],
      },
      title: name,
    });
  const file = (name: string) => join(dir, "people", `${name}.md`);
  git(root, ["init", "-q"]);
  // No commit yet: every page is new.
  await Bun.write(file("hans"), page("Hans", ["Builds the roof."]));
  expect(changedSinceCommit(root, dir)).toEqual([
    { added: 1, moved: 0, page: "Hans", removed: 0 },
  ]);
  await Bun.write(file("ana"), page("Ana", ["Sells the tiles."]));
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "night",
  ]);
  expect(changedSinceCommit(root, dir)).toEqual([]);
  // A hand run's rewrite, a page gone, a page new: all against the night before.
  await Bun.write(
    file("hans"),
    page("Hans", ["Builds the roof.", "Paid the tiles."])
  );
  await rm(file("ana"));
  await Bun.write(file("zoe"), page("Zoe", ["Moved in."]));
  expect(
    changedSinceCommit(root, dir).sort((a, b) => a.page.localeCompare(b.page))
  ).toEqual([
    { added: 0, moved: 0, page: "Ana", removed: 1 },
    { added: 1, moved: 0, page: "Hans", removed: 0 },
    { added: 1, moved: 0, page: "Zoe", removed: 0 },
  ]);
  // Outside a git repository: an error, never an empty report.
  const lone = await mkdtemp(join(tmpdir(), "no-git-"));
  expect(() => changedSinceCommit(lone, lone)).toThrow();
  await rm(lone, { recursive: true });
  await rm(root, { recursive: true });
}, 20_000); // two dozen git runs: seconds on Windows, where a process starts slowly
