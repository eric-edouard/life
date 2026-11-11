import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readDescriptions } from "../sources/photo-descriptions";
import { describePhotos } from "./describe-photos";

// A made-up library: a database with three photos, the newest with no image, the others with a preview.
function library() {
  const dir = join(mkdtempSync(join(tmpdir(), "describe-")), "database");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "Photos.sqlite"));
  db.run(`create table ZASSET (Z_PK integer primary key, ZUUID text, ZDATECREATED real, ZKIND integer, ZTRASHEDSTATE integer,
    ZHIDDEN integer, ZISDETECTEDSCREENSHOT integer, ZVISIBILITYSTATE integer, ZDIRECTORY text, ZFILENAME text)`);
  for (const [i, uuid] of ["AA1", "BB2", "CC3"].entries()) {
    db.run("insert into ZASSET values (?, ?, ?, 0, 0, 0, 0, 0, ?, ?)", [
      i + 1,
      uuid,
      800_000_000 + i,
      uuid.slice(0, 1),
      `${uuid}.heic`,
    ]);
  }
  db.close();
  for (const uuid of ["AA1", "BB2"]) {
    const file = join(
      dirname(dir),
      "resources",
      "derivatives",
      uuid.slice(0, 1),
      `${uuid}_1_105_c.jpeg`
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `image of ${uuid}`);
  }
  return dir;
}

test("a pass describes what has an image, one fails, one has none; the model runs only for the ones with an image and is stopped", async () => {
  const library_ = library();
  const descriptions = join(dirname(library_), "descriptions.sqlite");
  let stopped = false;
  const seen: string[] = [];
  const start = () =>
    Promise.resolve({
      describe: (image: Uint8Array, prompt: string) => {
        const what = new TextDecoder().decode(image);
        seen.push(what);
        if (what.endsWith("AA1")) {
          return Promise.reject(new Error("the describer answered 503"));
        }
        expect(prompt).toContain("factual");
        return Promise.resolve("Two people at a table.");
      },
      stop: () => {
        stopped = true;
        return Promise.resolve();
      },
    });
  await describePhotos({ descriptions, library: library_, start });
  expect(seen).toEqual(["image of BB2", "image of AA1"]);
  expect(stopped).toBe(true);
  expect(readDescriptions(["AA1", "BB2", "CC3"], descriptions)).toEqual(
    new Map([["BB2", "Two people at a table."]])
  );
  // Nothing is waiting but the failed one, which waits a day: a second pass starts no model.
  await describePhotos({
    descriptions,
    library: library_,
    start: () => {
      throw new Error("started");
    },
  });
});
