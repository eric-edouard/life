import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// The audits' regression cases (docs/audits.md), in his data repo. On a Mac without it there is nothing to check.
const LIFE = join(homedir(), "Life");
const CASES = join(LIFE, "docs/evals/cases");

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

test.skipIf(!existsSync(CASES))(
  "every regression case is well formed, cites its audit, and a held one points at what holds it",
  () => {
    const files = readdirSync(CASES).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const c = Case.parse(JSON.parse(readFileSync(join(CASES, file), "utf8")));
      const at = `${file}: `;
      expect(existsSync(join(LIFE, c.audit)), `${at}its audit`).toBe(true);
      expect(c.check === null, `${at}check is null only while pending`).toBe(
        c.status === "pending"
      );
      if (c.status === "test") {
        // A test names its case, so dropping either shows here.
        const path = join(import.meta.dir, "..", c.check ?? "");
        expect(existsSync(path), `${at}its test`).toBe(true);
        expect(readFileSync(path, "utf8"), `${at}its test names it`).toContain(
          file.replace(".json", "")
        );
      }
      if (c.status === "facts") {
        expect(
          existsSync(join(LIFE, "docs/evals", c.check ?? "")),
          `${at}its facts`
        ).toBe(true);
      }
    }
  }
);
