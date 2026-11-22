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
  "DiagnosticsView.swift": {
    padding: 2,
  },
  "Inbox/AnswerResultView.swift": {
    padding: 9,
  },
  "Inbox/NameVoices.swift": {
    capsule: 2,
    height: 1,
    width: 2,
  },
  "Matters/MatterThreadPage.swift": {
    padding: 5,
  },
  "Matters/StartAgentSheet.swift": {
    padding: 4,
  },
  "Pendant/IncidentCards.swift": {
    padding: 1,
  },
  "Settings/ConnectionPage.swift": {
    padding: 3,
  },
  "Settings/SettingsView.swift": {
    padding: 1,
  },
  "Settings/VocabularyView.swift": {
    font: 1,
    height: 1,
    padding: 2,
    width: 1,
  },
  "Shell/HomeList.swift": { capsule: 2, height: 1, padding: 2 },
  "Shell/NavShell.swift": {
    font: 1,
    height: 2,
    opacity: 1,
    padding: 2,
    width: 4,
  },
  "Shell/ReadScreen.swift": {
    padding: 2,
  },
};

const countsOf = (text: string) =>
  Object.fromEntries(
    Object.entries(RULES)
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
