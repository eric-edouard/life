import { expect, test } from "bun:test";
import type { Correction } from "../records/observation";
import { outdatedBy } from "./retirements";

// His yes of 22 Nov 2026: his Reopen of a closed matter lifts the `outdated` before it; a later `outdated` wins again.
test("a matter-reopened after an outdated lifts its retirement, and a later outdated retires it again", () => {
  const line = (kind: string, at: string) =>
    ({
      at,
      kind,
      schemaVersion: 1,
      ...(kind === "outdated"
        ? { observations: ["obs_000000000001"] }
        : { matter: "matter_000000000001", steps: ["obs_000000000001"] }),
    }) as Correction;
  const done = line("outdated", "2026-11-20T10:00:00.000Z");
  const reopened = line("matter-reopened", "2026-11-21T10:00:00.000Z");
  expect(outdatedBy([done])).toHaveLength(1);
  expect(outdatedBy([done, reopened])).toEqual([]);
  expect(
    outdatedBy([done, reopened, line("outdated", "2026-11-22T10:00:00.000Z")])
  ).toHaveLength(1);
});
