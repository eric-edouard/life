// Fails if a regression case (docs/audits.md) in his data repo is malformed, cites no audit file, or is held by a test
// that is gone or no longer names it (`bun run check`). Paths in a case are his data repo's, but a test's is this
// repo's. Skips when his data is absent (CI, other machines).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DATA } from "../src/truth";

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

const problems = readdirSync(CASES)
  .filter((f) => f.endsWith(".json"))
  .flatMap((file) => {
    const parsed = Case.safeParse(
      JSON.parse(readFileSync(join(CASES, file), "utf8"))
    );
    if (!parsed.success) {
      return [`${file}: ${z.prettifyError(parsed.error)}`];
    }
    const c = parsed.data;
    const test = join(import.meta.dir, "..", c.check ?? "");
    return [
      existsSync(join(DATA, c.audit)) ? "" : "its audit file is missing",
      (c.check === null) === (c.status === "pending")
        ? ""
        : "check is null only while pending",
      // A test names its case, so dropping either shows here.
      c.status === "test" &&
      !(
        existsSync(test) &&
        readFileSync(test, "utf8").includes(file.slice(0, -5))
      )
        ? `its test ${c.check} is missing or no longer names it`
        : "",
      c.status === "facts" && !existsSync(join(DATA, c.check ?? ""))
        ? `its facts ${c.check} are missing`
        : "",
    ].flatMap((p) => (p ? [`${file}: ${p}`] : []));
  });

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
