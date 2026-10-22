// Fails if a regression case (docs/operations.md, "Regression cases") in his data repo is malformed, cites no audit
// file, or is held by a test that is gone or no longer names it (`bun run check`). Paths in a case are his data
// repo's, but a test's is this repo's. Skips when his data is absent (CI, other machines).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "server/src/core/files";
import { DATA } from "server/src/core/paths";
import { z } from "zod";

const CASES = join(DATA, "docs/evals/cases");
if (!existsSync(CASES)) {
  console.log(`cases: skipped, no ${CASES}`);
  process.exit(0);
}

const Case = z
  .object({
    audit: z.string(),
    check: z.string().min(1).nullable(),
    class: z
      .array(z.enum(["C", "H", "E", "O", "T", "R", "J", "F", "N", "P"]))
      .min(1),
    evidence: z.record(z.string(), z.string()),
    expected: z.string().min(1),
    mustNot: z.string().min(1),
    status: z.enum(["pending", "test", "facts", "scenario"]),
    why: z.string().min(1),
  })
  .strict();

/** A file's text, or null when the path is no file. */
const textOf = (path: string) =>
  existsSync(path) && statSync(path).isFile()
    ? readFileSync(path, "utf8")
    : null;

const problems = readdirSync(CASES)
  .filter((f) => f.endsWith(".json"))
  .flatMap((file) => {
    const json = readJson<unknown>(join(CASES, file));
    if (json === undefined) {
      return [`${file}: not JSON`];
    }
    const parsed = Case.safeParse(json);
    if (!parsed.success) {
      return [`${file}: ${z.prettifyError(parsed.error)}`];
    }
    const c = parsed.data;
    // The check runs the server's tests, so a test that holds a case lives there and names it.
    const test = c.check?.startsWith("apps/server/src/")
      ? textOf(join(import.meta.dir, "..", c.check))
      : null;
    return [
      textOf(join(DATA, c.audit)) === null ? "its audit file is missing" : "",
      (c.check === null) === (c.status === "pending")
        ? ""
        : "check is null only while pending",
      c.status === "test" && !test?.includes(file.slice(0, -5))
        ? `its test ${c.check} is not in apps/server/src/, is missing or no longer names it`
        : "",
      c.status === "facts" && textOf(join(DATA, c.check ?? "")) === null
        ? `its facts ${c.check} are missing`
        : "",
    ].flatMap((p) => (p ? [`${file}: ${p}`] : []));
  });

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
