// Fails if `.fallow-baseline.json` holds anything but boundary violations, or more of them than origin/main's: the
// baseline lists what was there before the zones and only shrinks (`bun run check`). Skips the comparison when
// origin/main has no baseline yet.
import { readFileSync } from "node:fs";
import { git } from "server/src/proc";

const FILE = ".fallow-baseline.json";
const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;
const here = parse(readFileSync(FILE, "utf8"));
const other = Object.entries(here).filter(
  ([key, v]) =>
    key !== "boundary_violations" && Array.isArray(v) && v.length > 0
);
if (other.length > 0) {
  console.log(
    `baseline: only boundary violations belong in ${FILE}, not ${other.map(([k]) => k).join(", ")}`
  );
  process.exit(1);
}
const count = (b: Record<string, unknown>) =>
  (b.boundary_violations as unknown[] | undefined)?.length ?? 0;
const shown = git(".", ["show", `origin/main:${FILE}`]);
const base = shown.exitCode === 0 ? shown.stdout.toString() : "";
if (base && count(here) > count(parse(base))) {
  console.log(
    `baseline: ${count(here)} violations, origin/main has ${count(parse(base))}: it only shrinks`
  );
  process.exit(1);
}
