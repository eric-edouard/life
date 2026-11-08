import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendJsonl } from "../core/files";
import { Statement } from "../records/statement";
import { readFactChecks } from "./fact-checks";
import { openFactChecks, RATINGS, recordRating, STATEMENTS } from "./ledger";

const NOW = Date.parse("2026-10-30T10:00:00.000Z");
const statement = (ref: string, at = "2026-10-29T10:00:00.000Z") => ({
  at,
  date: "2026-10-28",
  group: "episodes" as const,
  kind: "fact" as const,
  ref,
  schemaVersion: 1 as const,
  source: "whatsapp" as const,
  text: `Zoé runs the bakery ${ref}.`,
  units: ["unit_000000000000"],
});

test("a fact check is open for 7 days from its draw until he answers it", async () => {
  for (const f of [RATINGS, STATEMENTS]) {
    rmSync(f, { force: true });
  }
  appendJsonl(STATEMENTS, Statement, [
    statement("obs_000000000001"),
    statement("obs_000000000002"),
    statement("obs_000000000003", "2026-10-22T09:00:00.000Z"),
  ]);
  recordRating("obs_000000000002", "true");
  const open = () => openFactChecks(NOW).map((s) => s.ref);
  expect(open()).toEqual(["obs_000000000001"]);
  const [asked] = await readFactChecks(NOW);
  expect(asked).toMatchObject({
    claim: "Zoé runs the bakery obs_000000000001.",
    ref: "obs_000000000001",
  });
});
