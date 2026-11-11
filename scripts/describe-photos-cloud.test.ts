import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDescriptions,
  readSettled,
} from "../apps/server/src/sources/photo-descriptions";
import { describeInCloud } from "./describe-photos-cloud";

// Made-up images; a fake `modal` (a bun script) prints its own progress first, like Modal's CLI, then answers all but photo B and never sees "no-image" photo C.
test("photos go to the cloud command and its answers are stored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-cloud-"));
  const image = (name: string) => {
    const path = join(dir, name);
    writeFileSync(path, "made-up image");
    return path;
  };
  const fake = join(dir, "fake.ts");
  writeFileSync(
    fake,
    `console.log("✓ Initialized. View run at https://modal.com/apps/made-up");
console.log(JSON.stringify({ level: "info", msg: "made-up container log" }));
let first = true;
for await (const l of console) {
  if (!l) continue;
  const j = JSON.parse(l);
  if (first) { first = false; if (!j.prompt) throw new Error("no prompt"); continue; }
  console.log(JSON.stringify(j.uuid === "B" ? { uuid: "B", error: "empty answer" } : { uuid: j.uuid, text: "seen " + j.uuid }));
}`
  );
  const descriptions = join(dir, "descriptions.sqlite");
  const described = await describeInCloud(
    [
      { preview: image("a.jpeg"), uuid: "A" },
      { preview: image("b.jpeg"), uuid: "B" },
      { uuid: "C" },
    ],
    { command: ["bun", fake], descriptions }
  );
  expect(described).toBe(1);
  expect([...readDescriptions(["A", "B", "C"], descriptions)]).toEqual([
    ["A", "seen A"],
  ]);
  expect(readSettled(descriptions)).toEqual(new Set(["A", "B", "C"]));
});
