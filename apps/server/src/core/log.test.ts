import { expect, test } from "bun:test";
import { join } from "node:path";
import { clock } from "./clock";
import { linesOf } from "./files";
import { LOG_DIR, log, logFileOf } from "./log";
import { errorOf, fromModel } from "./log-line";

const lastLine = () =>
  JSON.parse(
    linesOf(join(LOG_DIR, logFileOf(clock().toISOString()))).at(-1) ?? "{}"
  );

test("a line is LogTape's: time, level, category and template first, then its fields; content fields dropped at any depth", () => {
  log("desk.runtime", {
    agent: "agent_1",
    nested: { body: "Ana's address", count: 2 },
    text: "Meet at noon",
    what: "turn",
  });
  const line = lastLine();
  expect(Object.keys(line).slice(0, 4)).toEqual([
    "time",
    "level",
    "category",
    "msg",
  ]);
  expect(line).toMatchObject({
    agent: "agent_1",
    category: ["life", "desk", "runtime"],
    kind: "desk.runtime",
    level: "info",
    msg: "desk runtime {what}",
    nested: { count: 2 },
  });
  expect(JSON.stringify(line)).not.toContain("Ana");
  expect(JSON.stringify(line)).not.toContain("noon");
});

test("a run's line is under its step; an error makes it an error, a refusal a warning", () => {
  log("run.error", { error: "boom", run: "r", step: "watch.today" });
  expect(lastLine()).toMatchObject({
    category: ["life", "watch", "today"],
    level: "error",
  });
  log("run.end", { ms: 3, step: "persona" });
  expect(lastLine()).toMatchObject({
    category: ["life", "memory", "persona"],
    msg: "run end in {ms}",
  });
  log("mcp.call", { refused: "not_done", tool: "read_day" });
  expect(lastLine()).toMatchObject({
    category: ["life", "mcp", "read_day"],
    level: "warn",
  });
});

test("a model's error keeps its type only; Life's own its first line", () => {
  const model = fromModel(new Error("served by a host: Ana said hi"));
  expect(errorOf(model)).toEqual({ error: "Error", errorType: "Error" });
  expect(errorOf(new TypeError("no such file: x.json\nat line 3"))).toEqual({
    error: "no such file: x.json",
    errorType: "TypeError",
  });
});

test("`time` and `kind` are the writer's: a caller's own are overwritten or kept aside", () => {
  log("desk.runtime", { kind: "mic", time: "caller-chosen" });
  expect(lastLine()).toMatchObject({ fieldKind: "mic", kind: "desk.runtime" });
  expect(lastLine().time).not.toBe("caller-chosen");
  expect(errorOf(fromModel("a thrown string, quoting Ana"))).toEqual({
    error: "Error",
    errorType: "Error",
  });
});
