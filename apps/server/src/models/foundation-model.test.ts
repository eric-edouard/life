import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askFoundationModel } from "./foundation-model";

// A made-up helper: answers its first request, refuses its second, then exits before the third.
const helper = join(mkdtempSync(join(tmpdir(), "fm-")), "helper");
writeFileSync(
  helper,
  `#!/bin/sh
read a; echo '{"os":"Version 27.2","reply":{"author":"person"}}'
read b; echo '{"detail":"sensitive","error":"refused"}'
exit 3
`
);
chmodSync(helper, 0o755);

const ask = {
  fields: [{ description: "who", name: "author" }],
  instructions: "Read it.",
  text: "Ann: hi?",
};

test("answers each request in order: a reply with its OS, a refusal, and unavailable once the helper is gone", async () => {
  const [a, b, c] = await askFoundationModel([ask, ask, ask], helper);
  expect(a).toEqual({ os: "Version 27.2", reply: { author: "person" } });
  expect(b).toEqual({ detail: "sensitive", error: "refused" });
  expect(c).toMatchObject({ error: "unavailable" });
  // Background priority (`taskpolicy -b`) is slow on a loaded Mac.
}, 30_000);

test("no helper answers every request unavailable, never a throw", async () => {
  expect(await askFoundationModel([ask], "")).toEqual([
    { detail: "no helper (LIFE_FOUNDATION_MODEL)", error: "unavailable" },
  ]);
  expect(await askFoundationModel([], helper)).toEqual([]);
});

test("its model.local line says whether every request was answered, from the replies, never the exit", async () => {
  const { logEvents, logFileOf } = await import("../core/log");
  const { clock } = await import("../core/clock");
  const helperSaying = (line: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "fm-")), "helper");
    writeFileSync(path, `#!/bin/sh\nwhile read q; do echo '${line}'; done\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const okOf = async (path: string, asks = [ask, ask]) => {
    await askFoundationModel(asks, path);
    // Today's file, not the newest: another test may leave a later day's.
    return logEvents(logFileOf(clock().toISOString()), "model.local").at(-1)
      ?.ok;
  };
  expect(await okOf(helperSaying('{"os":"1","reply":{"a":"b"}}'))).toBe(true);
  expect(await okOf(helperSaying('{"detail":"x","error":"refused"}'))).toBe(
    false
  );
  expect(await okOf(helperSaying('{"detail":"x","error":"unsupported"}'))).toBe(
    false
  );
  // Answers one, refuses one, then exits before the third: a mixed batch.
  expect(await okOf(helper, [ask, ask, ask])).toBe(false);
}, 60_000);
