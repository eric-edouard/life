import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../proc";
import { renderPage } from "./page";
import { changedSinceCommit, removeOrphans } from "./pages";

test("pages no target claims are deleted, the others stay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pages-"));
  await mkdir(join(dir, "people"));
  await mkdir(join(dir, "areas"));
  await Promise.all(
    ["people/zoe.md", "people/inf-anais.md", "areas/shop.md"].map((f) =>
      Bun.write(join(dir, f), "x")
    )
  );
  const keep = new Set([
    join(dir, "people/zoe.md"),
    join(dir, "areas/shop.md"),
  ]);
  await removeOrphans(dir, keep);
  expect(await readdir(join(dir, "people"))).toEqual(["zoe.md"]);
  expect(await readdir(join(dir, "areas"))).toEqual(["shop.md"]);
  await rm(dir, { recursive: true });
});

test("what changed is counted against the last commit, so a midday rewrite shows in the night's report", async () => {
  const root = await mkdtemp(join(tmpdir(), "life-"));
  const dir = join(root, "memory", "pages");
  await mkdir(join(dir, "people"), { recursive: true });
  const page = (lines: string[]) =>
    renderPage({
      hold: "",
      meta: {
        built: "2026-10-20T00:00:00.000Z",
        madeBy: { engine: "claude", model: "m", prompt: "p", run: "r" },
        name: "Hans",
        page: "person:hans",
        schemaVersion: 1,
        seen: "r",
      },
      owner: [],
      sections: {
        health: [],
        history: [],
        now: lines.map((text) => ({ cites: ["obs_aaaaaaaaaaaa"], text })),
        views: [],
      },
      title: "Hans",
    });
  const file = join(dir, "people", "hans.md");
  await Bun.write(file, page(["Builds the roof."]));
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "night"],
  ]) {
    git(root, args);
  }
  expect(changedSinceCommit(root, dir)).toEqual([]);
  // A midday run rewrites it; the night adds a line more: the report counts both against the night before.
  await Bun.write(file, page(["Builds the roof.", "Paid the tiles."]));
  expect(changedSinceCommit(root, dir)).toEqual([
    { added: 1, moved: 0, page: "Hans", removed: 0 },
  ]);
  await rm(root, { recursive: true });
});
