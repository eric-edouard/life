import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../core/proc";
import { integrity, loadTruth, ownerIn } from "../memory/read-truth";
import { lifelogServer } from "../sources/store-fixtures";
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

test("init seeds where he is by the phone's zone first", async () => {
  const data = join(mkdtempSync(join(tmpdir(), "life-init-zone-")), "data");
  const server = lifelogServer({
    "/status": () => ({ phoneHeartbeat: { timeZone: "Asia/Jakarta" } }),
  });
  try {
    await init({ email: [], name: "Sam Doe", phone: [] }, data);
  } finally {
    server.close();
  }
  const [line] = readFileSync(join(data, "memory", "zones.jsonl"), "utf8")
    .trim()
    .split("\n");
  expect(JSON.parse(line ?? "{}").tz).toBe("Asia/Jakarta");
}, 20_000);
