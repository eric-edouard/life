import { expect, spyOn, test } from "bun:test";
import { nextStepNow } from "../memory/matter-read";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as readMatters from "../memory/read-matters";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as inbox from "./inbox";
import { matterRowsNowOf, readMatterRowsNow } from "./matter-rows";

// The one matter row composition, on made-up matters and checks.

const row = (id: string, kind = "do", status = "moving") => ({
  id,
  nextStep: { kind },
  status,
});
/** An open check on matter `id`: a name blocks him, an ending only improves. */
const check = (id: string, group: "ending" | "name") => ({
  deadline: null,
  group,
  matter: { id, name: `Matter ${id}` },
  ridesOn: { matterIds: [], matters: 1, observations: 0, pages: 0 },
  subject: null,
});

test("a row needs him for his own next step or a check that blocks him, never for one that only improves or a stuck matter's", () => {
  const rows = matterRowsNowOf(
    [
      row("own", "wait_owner"),
      row("stuck", "wait_owner", "stuck"),
      row("blocked"),
      row("improved"),
      row("calm"),
    ],
    [check("blocked", "name"), check("improved", "ending")]
  );
  expect(rows.map((r) => [r.id, r.blockingChecks, r.needsYou])).toEqual([
    ["own", 0, true],
    ["stuck", 0, false],
    ["blocked", 1, true],
    ["improved", 0, false],
    ["calm", 0, false],
  ]);
});

test("the desk's count: an open decision on a matter's step makes its next step his", () => {
  const v = {
    id: "decided",
    nextStep: { kind: "do", text: "Do it" },
    status: "moving",
    steps: [{ ref: "obs_decided" }],
  };
  const decisions = [{ question: "Which?", subject: "obs_decided" }];
  const [r] = matterRowsNowOf(
    [{ ...v, nextStep: nextStepNow(v as never, decisions) }],
    []
  );
  expect(r?.needsYou).toBe(true);
});

test("a person's read and read_matters take their rows from one reader, read again only when the checks' key moves", async () => {
  const open = spyOn(readMatters, "openMatters").mockResolvedValue({
    matters: [],
  } as never);
  const checks = spyOn(inbox, "openChecksAndKeyNow").mockResolvedValue({
    checks: [],
    key: "one reader",
  });
  try {
    const first = await readMatterRowsNow();
    // Read once per key: the same key reads nothing again; a new checks' key (it covers Life's icon picks) reads
    // again. The version is the answer's: the same rows, the same version.
    expect(await readMatterRowsNow()).toBe(first);
    expect(open).toHaveBeenCalledTimes(1);
    checks.mockResolvedValue({ checks: [], key: "a new reader" });
    expect((await readMatterRowsNow()).version).toBe(first.version);
    checks.mockResolvedValue({ checks: [], key: "a pick landed" });
    open.mockResolvedValue({
      matters: [{ id: "matter_000000000001" }],
    } as never);
    expect((await readMatterRowsNow()).version).not.toBe(first.version);
    expect(open).toHaveBeenCalledTimes(3);
  } finally {
    open.mockRestore();
    checks.mockRestore();
  }
});
