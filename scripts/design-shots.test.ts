import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIGN_DATA,
  FRAME_MAP,
  parseArgs,
  ROUTE_FLAGS,
  readAppFrames,
} from "./design-shots";
import { buildApp, sourceStamp } from "./simulator";

const appFrames = readAppFrames();

test("every flag a frame launches with is one the app's fixture reads", () => {
  const fixture = readFileSync(
    join(
      import.meta.dir,
      "../apps/lifelog/apps/ios/Lifelog/Fixtures/LifeFixture.swift"
    ),
    "utf8"
  );
  const read = new Set(
    [...fixture.matchAll(/value\(of: "(-\w+)"\)/g)].map((m) => m[1])
  );
  const flags = Object.values(appFrames).flatMap((frame) =>
    (frame.args ?? []).filter((arg) => arg.startsWith("-"))
  );
  expect(flags.filter((flag) => !read.has(flag))).toEqual([]);
});

test("every route flag the shots wait on is one the app's fixture reads", () => {
  const fixture = readFileSync(
    join(
      import.meta.dir,
      "../apps/lifelog/apps/ios/Lifelog/Fixtures/LifeFixture.swift"
    ),
    "utf8"
  );
  expect(
    [...ROUTE_FLAGS].filter((flag) => !fixture.includes(`"${flag}"`))
  ).toEqual([]);
});

test("every frame has args to launch with, or a why it has none (never both, never neither)", () => {
  const bad = Object.entries(appFrames).filter(
    ([, f]) => (f.args === undefined) === (f.why === undefined)
  );
  expect(bad.map(([name]) => name)).toEqual([]);
});

test("the live-logs and plan frames stay named (a merge once dropped seven)", () => {
  const kept = [
    "DuoFoldSettingsLogs",
    "DuoFoldLogs",
    "DuoFoldLogsPaused",
    "DuoFoldLogsProblems",
    "DuoFoldLogDetail",
    "DuoFoldLogsEmpty",
    "DuoFoldLogsOffline",
    "DuoFoldStackPlan",
    "StackPlan",
    "StackPlanLong",
  ];
  expect(kept.filter((name) => !appFrames[name])).toEqual([]);
});

test.skipIf(!existsSync(FRAME_MAP))(
  "every frame named is one the designer's frame map holds",
  () => {
    const { frames } = JSON.parse(readFileSync(FRAME_MAP, "utf8")) as {
      frames: Record<string, unknown>;
    };
    expect(
      Object.entries(appFrames)
        .filter(([name, app]) => !(frames[name] || app.drawing))
        .map(([name]) => name)
    ).toEqual([]);
  }
);

const CREATE_FLOW = join(DESIGN_DATA, "create-person-and-organization.json");

interface WireCheck {
  about?: string[];
  onMatters?: { name: string }[];
  options: { id: string; label: string; takes?: string }[];
  question: string;
  said?: { by?: string };
}

/** What the designer's extract says of a frame (the fields a frame of the create flow has). */
interface CreateFrame {
  answers: { main: string; quiet: string[] };
  fields: { label: string; value: string }[];
  question: string;
}

test("the create flow's answers and Life's guess read as the designer's extract, from the same data", () => {
  const { frames } = JSON.parse(readFileSync(CREATE_FLOW, "utf8")) as {
    frames: Record<string, CreateFrame>;
  };
  const frameOf = (name: string) => frames[name] as CreateFrame;
  const { checks } = JSON.parse(
    readFileSync(join(DESIGN_DATA, "read_inbox.json"), "utf8")
  ) as { checks: WireCheck[] };
  const cardOf = (question: string) =>
    checks.find((c) => c.question === question) as WireCheck;
  for (const name of ["AskNameNone", "OrgNameCard"]) {
    const frame = frameOf(name);
    const card = cardOf(frame.question);
    // The app's words: "Create <name>", and "Someone I know…" for the naming option with no one to suggest (CheckActions).
    expect(`Create ${card.about?.at(-1)}`).toBe(frame.answers.main);
    expect(
      card.options.map((o) =>
        o.takes === "person or name" ? "Someone I know…" : o.label
      )
    ).toEqual(frame.answers.quiet);
  }
  // Life's guess of who they are, as CreateSheet's `guessOf` builds it from the card.
  const card = cardOf(frameOf("AskNameNone").question);
  const who = frameOf("PersonCreate").fields.find(
    (f) => f.label === "Who they are"
  );
  expect(
    `Mentioned by ${card.said?.by}, about “${card.onMatters?.[0]?.name}”`
  ).toBe(who?.value as string);
});

test("the simulator stays booted unless --shutdown; a built app is taken as given", () => {
  expect(
    parseArgs(["A", "--app", "/x/lifelog.app", "B", "--compare", "d"])
  ).toEqual({
    app: "/x/lifelog.app",
    asked: ["A", "B"],
    compare: "d",
    shutdownAfter: false,
  });
  expect(parseArgs(["--shutdown"]).shutdownAfter).toBe(true);
});

test("a build of the same sources is reused, without building", async () => {
  const dd = mkdtempSync(join(tmpdir(), "dd-"));
  const app = join(dd, "Build/Products/Debug-iphonesimulator/lifelog.app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(dd, ".source-stamp"), await sourceStamp());
  expect(await buildApp("none", dd)).toBe(app);
});
