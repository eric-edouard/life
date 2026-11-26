import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { writeJson } from "../core/files";
import {
  cutInLine,
  DeletionRequest,
  deletionDigestOf,
  deletionProblemOf,
  readShownSituations,
} from "./delete-from-memory";
import { cutOf, dependentsOf, shownKeyOf } from "./deletions";
import { matterSituationPath } from "./situation-parts";

const DIGEST = /^[0-9a-f]{16}$/;

// A deletion's door (docs/glossary.md, "deletion"): the words it cuts, the digest a second call must repeat, and the one
// refusal it gives for an empty ask. Made-up lines throughout.

test("a quote is cut where it sits: its places and the digest of what was there, never the words", () => {
  const text = "Meet me at the pier, room 4B.";
  const cut = cutInLine(text, "the pier", "msg:whatsapp|m1");
  expect(cut).toEqual(cutOf("msg:whatsapp|m1", text, 11, 19));
  expect(cut?.digest).toBe(cutOf("x", text, 11, 19).digest);
  // The places hold: what is after them is untouched.
  expect(text.slice(cut?.to)).toBe(", room 4B.");
  // Words that are not in the line are no cut at all, and neither are accents or case differences of them.
  expect(cutInLine(text, "the harbour", "m1")).toBeNull();
  expect(cutInLine(text, "THE PIER", "m1")?.from).toBe(11);
});

test("the digest of a set holds what the second call must repeat: its refs, its cuts and withSources, in any order", () => {
  const cut = cutOf("m1", "the pier", 0, 3);
  const plan = (
    over: Partial<Parameters<typeof deletionDigestOf>[0]> = {}
  ) => ({
    cuts: [cut],
    named: [{ id: "unit_000000000001" }, { id: "obs_000000000002" }],
    withSources: false,
    ...over,
  });
  expect(deletionDigestOf(plan())).toMatch(DIGEST);
  expect(deletionDigestOf(plan())).toBe(
    deletionDigestOf({ ...plan(), named: [...plan().named].reverse() })
  );
  expect(deletionDigestOf(plan({ withSources: true }))).not.toBe(
    deletionDigestOf(plan())
  );
  expect(deletionDigestOf(plan({ cuts: [] }))).not.toBe(
    deletionDigestOf(plan())
  );
  expect(
    deletionDigestOf(plan({ named: [{ id: "unit_00000000000f" }] }))
  ).not.toBe(deletionDigestOf(plan()));
});

test("a deletion asks for refs, cuts or about; asking for nothing is refused before anything is read", () => {
  const said = { said: "that goes" };
  expect(deletionProblemOf(DeletionRequest.parse(said))).toBe(
    "a deletion names refs, cuts or about"
  );
  expect(
    deletionProblemOf(DeletionRequest.parse({ ...said, refs: ["unit_x"] }))
  ).toBeNull();
  expect(
    deletionProblemOf(DeletionRequest.parse({ ...said, about: "the pier" }))
  ).toBeNull();
});

test("`said` is his words and is required; `withSources` and `cuts` are left out by default", () => {
  expect(DeletionRequest.safeParse({ refs: ["unit_x"] }).success).toBe(false);
  expect(
    DeletionRequest.safeParse({ refs: ["unit_x"], said: "that goes" }).data
  ).toMatchObject({ cuts: [], withSources: false });
  // A `confirm` that is not a preview's digest is refused before the request reaches anything.
  expect(
    DeletionRequest.safeParse({ confirm: "abc", refs: ["unit_x"], said: "x" })
      .success
  ).toBe(false);
  // A key it does not know is refused, as every record of his is.
  expect(
    DeletionRequest.safeParse({ refs: [], said: "x", something: 1 }).success
  ).toBe(false);
});

test("a matter's situation is hidden by a deleted fact its call was shown, even one no part cites", async () => {
  const id = "matter_dddddddddddd";
  const path = matterSituationPath(id);
  writeJson(path, {
    built: "2026-11-20T00:00:00.000Z",
    inputs: "0123456789abcdef",
    madeBy: { engine: "claude", model: "m", prompt: "p", run: "r" },
    parts: [
      { cites: ["obs_cited000000"], markdown: "You asked Ben for a quote." },
    ],
    schemaVersion: 2,
    shown: ["obs_cited000000", "obs_uncited00000", "unit_found"],
    subject: id,
  });
  try {
    const shown = (await readShownSituations()).filter((s) =>
      s.id.endsWith(id)
    );
    const reached = (refs: string[]) =>
      dependentsOf(refs, {
        cards: [],
        matters: [],
        observations: [
          { id: "obs_uncited00000", source: "m9", unit: "unit_9" },
        ],
        shown,
        todoItems: [],
        units: [{ id: "unit_9", refs: ["m9"] }],
      }).shown;
    // The message holding the fact no part cites: its fact is reached, so the reading hides until redone.
    expect(reached(["m9"])).toEqual([shownKeyOf.matterSituation(id)]);
    expect(reached(["unit_found"])).toEqual([shownKeyOf.matterSituation(id)]);
    expect(reached(["m_other"])).toEqual([]);
  } finally {
    rmSync(path, { force: true });
  }
});
