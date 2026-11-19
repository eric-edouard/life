import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFE_CODE_DIR } from "@life/server/src/core/paths";
import { repoFiles } from "@life/server/src/core/proc";

// The phone's screens draw with the design system (`DesignSystem/`, `Shared/Palette.swift`, `Shared/Metrics.swift`):
// a type step, a palette colour, a Metrics value, a component. Each rule below counts what a screen draws by hand; its
// cap is today's count and only goes down (lower it as a screen moves onto the system; never raise it).
const APP = "apps/lifelog/apps/ios/Lifelog";
// The system itself, the debug fixtures, and the two drawings that paint the pendant (AGENTS.md's colour exception).
const EXEMPT = [
  `${APP}/DesignSystem/`,
  `${APP}/Fixtures/`,
  "HALLens.swift",
  "LightGuide.swift",
  "Previews.swift",
];

const RULES: { what: string; pattern: RegExp; cap: number }[] = [
  {
    what: "a system font, not a type step",
    pattern: /\.font\(\.system\(/g,
    cap: 5,
  },
  { what: "a literal corner radius", pattern: /cornerRadius: *\d/g, cap: 0 },
  {
    what: "a hand-drawn capsule",
    pattern: /Capsule\(\)|in: \.capsule/g,
    cap: 10,
  },
  { what: "a colour not from the palette", pattern: /\bColor\(/g, cap: 0 },
  {
    what: "a spacing number, not Metrics",
    pattern: /\.padding\([^)]*\d/g,
    cap: 101,
  },
  { what: "a literal height", pattern: /frame\([^)]*[Hh]eight: *\d/g, cap: 14 },
  { what: "an ad hoc opacity", pattern: /\.opacity\(0\./g, cap: 1 },
];

const screens = repoFiles(LIFE_CODE_DIR, [APP], [".swift"]).filter(
  (path) => !EXEMPT.some((e) => path.includes(e))
);
const texts = screens.map((path) =>
  readFileSync(join(LIFE_CODE_DIR, path), "utf8")
);

test("screens draw with the design system: each count of hand-drawn styling is at its cap", () => {
  const counts = RULES.map(({ what, pattern }) => [
    what,
    texts.reduce((n, text) => n + (text.match(pattern)?.length ?? 0), 0),
  ]);
  expect(counts).toEqual(RULES.map(({ what, cap }) => [what, cap]));
});
