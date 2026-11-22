import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execOk } from "@life/server/src/core/proc";
import { FRAME_MAP, flagsOf } from "./design-shots";

// `bun run design:export <Frame…> [--out <dir>]`: what a UI build needs from the design, for a model that cannot see a picture
// as much as for one that can. Each frame asked as text (`<Frame>.html`: the layout tree with boxes, token names, text and
// states, written by the designer's `render_frames.py --spec` from the frame itself) and as its picture (`<Frame>.png`), then
// the design pack the designer lists in `design-pack.json`: the system and the guidelines, every time, with `index.md`
// naming each file. `--out` defaults to `derived/design`. The screen is then checked against the frames with `bun run design:shots <Frame> --compare <dir>`.

const REPO = join(import.meta.dir, "..");
const DESIGN = dirname(FRAME_MAP);

/** The design pack as the designer lists it (`design-pack.json`): each file found, its path in the pack, and what it is for. */
function readPack() {
  const { files } = JSON.parse(
    readFileSync(join(DESIGN, "design-pack.json"), "utf8")
  ) as { files: [string, string][] };
  return files.flatMap(([pattern, why]) => {
    const isRepo = pattern.startsWith("repo:");
    const root = isRepo ? REPO : DESIGN;
    const found = [
      ...new Bun.Glob(pattern.replace("repo:", "")).scanSync({ cwd: root }),
    ].sort();
    if (found.length === 0) {
      throw new Error(`design-pack.json names ${pattern}, which is not there`);
    }
    return found.map((path) => ({
      from: join(root, path),
      to: join("pack", isRepo ? "repo" : "", path),
      why,
    }));
  });
}

async function main() {
  const { asked: frames, values } = flagsOf(process.argv.slice(2), ["--out"]);
  const out = resolve(values["--out"] ?? join(REPO, "derived/design"));
  const pack = readPack();
  if (frames.length === 0) {
    throw new Error("name the frames the task needs: design:export <Frame…>");
  }
  mkdirSync(join(out, "pack"), { recursive: true });
  await execOk([
    ...["python3", join(DESIGN, "gen/render_frames.py"), "--spec"],
    ...["--out", out, ...frames],
  ]);
  for (const { from, to } of pack) {
    mkdirSync(dirname(join(out, to)), { recursive: true });
    copyFileSync(from, join(out, to));
  }
  writeFileSync(
    join(out, "index.md"),
    [
      "# The design for this task",
      "",
      "Each frame twice: `<Frame>.html` is the screen as text (box = x y w h in points from the screen's top left; t = tokens; label, state, opens), `<Frame>.png` its picture.",
      `Check the app against a frame: \`tools/heavy.sh bun run design:shots <Frame> --compare ${out}\` (no gaps: done).`,
      "",
      ...frames.map((frame) => `- ${frame}.html, ${frame}.png`),
      "",
      "## The design pack",
      "",
      ...pack.map(({ to, why }) => `- ${to}: ${why}`),
      "",
    ].join("\n")
  );
  console.log(join(out, "index.md"));
}

if (import.meta.main) {
  await main();
}
