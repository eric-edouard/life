import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execOk } from "@life/server/src/core/proc";
import { FRAME_MAP } from "./design-shots";

// `bun run design:export <Frame…> [--out <dir>]`: what a UI build needs from the design, for a model that cannot see a picture
// as much as for one that can. Each frame asked as text (`<Frame>.html`: the layout tree with boxes, token names, text and
// states, written by the designer's `render_frames.py --spec` from the frame itself) and as its picture (`<Frame>.png`), then
// the design pack: the system and the guidelines, every time, with `index.md` naming each file. `--out` defaults to
// `derived/design`. The screen is then checked against the frames with `bun run design:shots <Frame> --compare <dir>`.

const REPO = join(import.meta.dir, "..");
const DESIGN = dirname(FRAME_MAP);

/** The design pack: each file, where it is read from, and what a builder reads it for. */
const PACK: [string, string][] = [
  [
    join(DESIGN, "BRIEF.md"),
    "Start here: the owner's rules, what is decided, where each thing is.",
  ],
  [
    join(DESIGN, "voice.md"),
    "The wording rules: removing his load comes first.",
  ],
  [
    join(DESIGN, "components.md"),
    "The system: native first, colour, type, shape, no borders, every component, motion.",
  ],
  [
    join(DESIGN, "gen/COMPONENTS.md"),
    "Every component the frames are drawn with: its signature and purpose.",
  ],
  [
    join(DESIGN, "gen/tokens.py"),
    "The sizes, radii and type styles (the R_ and T_ names in a frame's t tokens).",
  ],
  [
    join(DESIGN, "gen/parts.py"),
    "One function per component: how each is drawn, in points.",
  ],
  [
    join(REPO, "assets/brand/tokens.css"),
    "The colour tokens (bg, fg, card… in a frame's t tokens), light and dark.",
  ],
  [
    join(REPO, "docs/brand.md"),
    "Life's brand: wording, motion, no borders, type.",
  ],
  [
    join(DESIGN, "nav-v3-design-2026-11-22.md"),
    "Navigation by pose: what each pose shows and how one moves.",
  ],
  [
    join(DESIGN, "nav-v3-prototype.html"),
    "The navigation reference, a working HTML prototype.",
  ],
  [
    join(DESIGN, "foldable-research-2026-11-18.md"),
    "Apple's guidance for the iPhone Duo, with sources.",
  ],
  ...readdirSync(DESIGN)
    .filter((name) => name.startsWith("decisions-") && name.endsWith(".md"))
    .map((name): [string, string] => [
      join(DESIGN, name),
      "What the owner decided, in order, with his words: the latest sections win.",
    ]),
];

/** Where a pack file lands: its path under the design folder or the repo, so `gen/COMPONENTS.md` and `components.md` both stay. */
const packed = (from: string) =>
  join("pack", relative(from.startsWith(DESIGN) ? DESIGN : REPO, from));

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--out");
  const out = resolve(
    at === -1 ? join(REPO, "derived/design") : String(argv[at + 1])
  );
  const frames = argv.filter(
    (arg, i) => !arg.startsWith("--") && (at === -1 || i !== at + 1)
  );
  if (frames.length === 0) {
    throw new Error("name the frames the task needs: design:export <Frame…>");
  }
  mkdirSync(join(out, "pack"), { recursive: true });
  await execOk([
    ...["python3", join(DESIGN, "gen/render_frames.py"), "--spec"],
    ...["--out", out, ...frames],
  ]);
  for (const [from] of PACK) {
    mkdirSync(dirname(join(out, packed(from))), { recursive: true });
    copyFileSync(from, join(out, packed(from)));
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
      ...PACK.map(([from, why]) => `- ${packed(from)}: ${why}`),
      "",
    ].join("\n")
  );
  console.log(join(out, "index.md"));
}

if (import.meta.main) {
  await main();
}
