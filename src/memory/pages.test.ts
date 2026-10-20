import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeOrphans } from "./pages";

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
  // Read before they go, so his edits on them can be kept.
  expect(await removeOrphans(dir, keep)).toEqual([
    { path: join(dir, "people/inf-anais.md"), text: "x" },
  ]);
  expect(await readdir(join(dir, "people"))).toEqual(["zoe.md"]);
  expect(await readdir(join(dir, "areas"))).toEqual(["shop.md"]);
  await rm(dir, { recursive: true });
});
