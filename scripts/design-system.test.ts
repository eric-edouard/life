import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LIFE_CODE_DIR } from "@life/server/src/core/paths";
import { repoFiles } from "@life/server/src/core/proc";

// The phone's screens draw with the design system (`DesignSystem/`, `Shared/Palette.swift`, `Shared/Metrics.swift`):
// a type step, a palette colour, a Metrics value, a component. Each rule counts what a screen draws by hand. CAPS holds
// each file's count per rule; a file not listed may have none. A cap only goes down: lower it as a screen moves onto
// the system, never raise it.
const APP = "apps/lifelog/apps/ios/Lifelog";
// The system itself and the debug fixtures.
const EXEMPT_DIRS = [`${APP}/DesignSystem/`, `${APP}/Fixtures/`];
// The two drawings that paint the pendant (AGENTS.md's colour exception) and the previews.
const EXEMPT_FILES = [
  "HALLens.swift",
  "LightGuide.swift",
  "PendantPreviews.swift",
];

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const RULES: Record<string, RegExp> = {
  capsule: /Capsule\(\)|in: \.capsule/g,
  colour: /\bColor\(/g,
  font: /\.font\(\.system\(/g,
  height: new RegExp(String.raw`frame\([^)]*[Hh]eight: *${NUMBER}`, "g"),
  opacity: /\.opacity\(0\./g,
  padding: new RegExp(String.raw`\.padding\((?:[^)]*,\s*)?${NUMBER}\s*\)`, "g"),
  radius: new RegExp(`cornerRadius: *${NUMBER}`, "g"),
  // The design's `Spinner`, never the system's bars.
  spinner: /ProgressView\(/g,
  // An agent shows its program's mark (`RuntimeName.mark`), never a star.
  star: /"sparkles?"/g,
  width: new RegExp(String.raw`frame\([^)]*[Ww]idth: *${NUMBER}`, "g"),
};

const CAPS: Record<string, Record<string, number>> = {
  "DiagnosticsView.swift": { padding: 2 },
  "Field/AskField.swift": { font: 1, height: 1, width: 1 },
  "Pendant/IncidentCards.swift": { padding: 1 },
  "RootView.swift": { height: 2, padding: 1, width: 2 },
  "Settings/ConnectionPage.swift": { padding: 3 },
  "Thread/AnswerView.swift": { width: 1 },
  "Thread/ThreadView.swift": { capsule: 1, height: 1 },
};

// The system's own files draw with names too: a motion is a `Motion` value, a padding a `Spacing` step. Each file's
// remaining numbers (a chat bubble's geometry, the dictation field's) are capped here and only go down.
const SYSTEM_RULES: Record<string, RegExp> = {
  ease: /\.easeOut\(|\.easeIn\(|\.easeInOut\(/g,
  padding: RULES.padding as RegExp,
  spring: /\.spring\(|\.interactiveSpring\(/g,
};
const SYSTEM_CAPS: Record<string, Record<string, number>> = {
  "DesignSystem/DraftBlock.swift": { padding: 11 },
  "DesignSystem/Pieces.swift": { padding: 12 },
};

const countsOf = (text: string, rules: Record<string, RegExp> = RULES) =>
  Object.fromEntries(
    Object.entries(rules)
      .map(
        ([rule, pattern]) => [rule, text.match(pattern)?.length ?? 0] as const
      )
      .filter(([, n]) => n !== 0)
  );

test("a rule counts numbers drawn by hand, never a Metrics value", () => {
  expect(
    countsOf(
      ".padding(.top, 8) .padding(12) .padding(.top, Metrics.Gap.s2) .padding(Metrics.gutter)"
    )
  ).toEqual({
    padding: 2,
  });
});

test("screens draw with the design system: each file's hand-drawn styling is at its cap", () => {
  const screens = repoFiles(LIFE_CODE_DIR, [APP], [".swift"]).filter(
    (path) =>
      !(
        EXEMPT_DIRS.some((d) => path.startsWith(d)) ||
        EXEMPT_FILES.includes(basename(path))
      )
  );
  const counts = Object.fromEntries(
    screens
      .map(
        (path) =>
          [
            path.slice(APP.length + 1),
            countsOf(readFileSync(join(LIFE_CODE_DIR, path), "utf8")),
          ] as const
      )
      .filter(([, c]) => Object.keys(c).length > 0)
  );
  expect(counts).toEqual(CAPS);
});

test("the design system's own files keep motions in Motion and paddings on the grid, within their caps", () => {
  const files = repoFiles(
    LIFE_CODE_DIR,
    [`${APP}/DesignSystem/`],
    [".swift"]
  ).filter((path) => basename(path) !== "Motion.swift");
  const counts = Object.fromEntries(
    files
      .map(
        (path) =>
          [
            path.slice(APP.length + 1),
            countsOf(
              readFileSync(join(LIFE_CODE_DIR, path), "utf8"),
              SYSTEM_RULES
            ),
          ] as const
      )
      .filter(([, c]) => Object.keys(c).length > 0)
  );
  expect(counts).toEqual(SYSTEM_CAPS);
});
