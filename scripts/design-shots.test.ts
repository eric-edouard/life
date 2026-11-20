import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAME_MAP, readAppFrames } from "./design-shots";

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

test.skipIf(!existsSync(FRAME_MAP))(
  "every frame named is one the designer's frame map holds",
  () => {
    const { frames } = JSON.parse(readFileSync(FRAME_MAP, "utf8")) as {
      frames: Record<string, unknown>;
    };
    expect(Object.keys(appFrames).filter((name) => !frames[name])).toEqual([]);
  }
);
