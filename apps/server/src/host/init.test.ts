import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../core/proc";
import { integrity, loadTruth, ownerIn } from "../memory/read-truth";
import { init } from "./init";

test("init makes a new owner's data that validates, commits it, and never runs twice", async () => {
  const data = join(mkdtempSync(join(tmpdir(), "life-init-")), "data");
  await init({ email: ["sam@example.com"], name: "Sam Doe", phone: [] }, data);
  const truth = await loadTruth(data);
  expect(integrity(truth)).toEqual([]);
  expect(ownerIn(truth.people).handles.email).toEqual(["sam@example.com"]);
  expect(truth.me.about).toBe("Sam Doe.");
  expect(git(data, ["log", "--format=%s"]).stdout.toString().trim()).toBe(
    "Life: start"
  );
  expect(
    init({ email: [], name: "Someone Else", phone: [] }, data)
  ).rejects.toThrow("is not empty");
}, 20_000); // eight git runs: seconds on Windows, where a process starts slowly
