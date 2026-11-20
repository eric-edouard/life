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
