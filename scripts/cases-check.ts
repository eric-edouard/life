// Fails if a regression case (docs/audits.md) in his data repo is malformed, cites no audit file, or is held by a test
// that is gone or no longer names it (`bun run check`). Paths in a case are his data repo's, but a test's is this
// repo's. Skips when his data is absent (CI, other machines).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** A file's text, or null when the path is no file. */
const textOf = (path: string) =>
  existsSync(path) && statSync(path).isFile()
    ? readFileSync(path, "utf8")
    : null;

/** Its JSON, or null when it is none. */
const jsonOf = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const problems = readdirSync(CASES)
  .filter((f) => f.endsWith(".json"))
  .flatMap((file) => {
    const parsed = Case.safeParse(jsonOf(textOf(join(CASES, file)) ?? ""));
    if (!parsed.success) {
      return [`${file}: ${z.prettifyError(parsed.error)}`];
    }
    const c = parsed.data;
    // `bun test ./src/` runs only src/, so a test that holds a case lives there and names it.
    const test = c.check?.startsWith("src/")
      ? textOf(join(import.meta.dir, "..", c.check))
      : null;
    return [
      textOf(join(DATA, c.audit)) === null ? "its audit file is missing" : "",
      (c.check === null) === (c.status === "pending")
        ? ""
        : "check is null only while pending",
      c.status === "test" && !test?.includes(file.slice(0, -5))
        ? `its test ${c.check} is not in src/, is missing or no longer names it`
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
