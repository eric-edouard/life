import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadOnly, openWritable } from "./sqlite";

test("a store opened to read waits for a writer and never writes", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-sqlite-")), "s.sqlite");
  new Database(path).run("create table t (x)");
  const db = openReadOnly(path);
  expect(db.query("pragma busy_timeout").get()).toEqual({ timeout: 5000 });
  expect(() => db.run("insert into t values (1)")).toThrow();
});

test("a writer opened while another connection holds a write lock waits instead of failing", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-sqlite-")), "w.sqlite");
  const holder = openWritable(path);
  holder.run("create table t (x)");
  holder.close();
  // A child holds an immediate transaction for 1 s; the writer's first statements must outwait it.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { Database } = require("bun:sqlite");
       const db = new Database(${JSON.stringify(path)});
       db.run("begin immediate"); console.log("held");
       setTimeout(() => { db.run("commit"); process.exit(0); }, 1000);`,
    ],
    { stdout: "pipe" }
  );
  await child.stdout.getReader().read();
  const db = openWritable(path);
  expect(() => db.run("insert into t values (1)")).not.toThrow();
  expect(db.query("pragma busy_timeout").get()).toEqual({ timeout: 5000 });
  db.close();
  await child.exited;
});
