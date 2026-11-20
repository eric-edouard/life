import { expect, test } from "bun:test";
import { nextStepNow } from "../memory/matter-read";
import { matterRowsNowOf } from "./matter-rows";

// The one matter row composition, on made-up matters and checks.

const row = (id: string, kind = "do", status = "moving") => ({
  id,
  nextStep: { kind },
  status,
});
/** An open check on matter `id`: a name blocks him, an ending only improves. */
const check = (id: string, group: "ending" | "name") => ({
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
