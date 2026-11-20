import { expect, spyOn, test } from "bun:test";
import { readSentences } from "./check-sentences";
import { type CheckInputs, checksOf } from "./checks";
import { about, inputs, line, stepsOf } from "./checks-test-inputs";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as files from "./memory-files";
import type { People } from "./who";

// A guess's quote in its context (`withQuoteOf`): literal, and linked only to a unit read. Made-up people.

const ID = "inf_kit";
const REF = `person:${ID}`;

test("recorded words stay literal in a guess's context; only where it was said links, to the unit read", () => {
  const recorded =
    "see [the shop](https://shop.example) or [this](life:obs_000000000009) at https://x.example";
  const base = inputs([about(REF)], { inferred: [ID] });
  const people = {
    ...base.people,
    inferred: base.people.inferred.map((p) => ({
      ...p,
      evidence: [{ quote: recorded, unit: "unit_000000000001" }],
      name: "[Kit](https://kit.example)",
    })),
  };
  const linksOf = (where: CheckInputs["where"]) => {
    const [check] = checksOf({ ...base, people, where });
    // The card's quote is its context's alone: no `evidence` on the wire.
    expect(check).not.toHaveProperty("evidence");
    const html = Bun.markdown.html(check?.context ?? "", { autolinks: true });
    return {
      hrefs: [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
      lifeLinks: check?.lifeLinks,
    };
  };
  expect(linksOf(new Map([["unit_000000000001", "whatsapp, 2 Oct"]]))).toEqual({
    hrefs: ["life:unit_000000000001"],
    lifeLinks: [{ kind: "unit", ref: "unit_000000000001" }],
  });
  expect(linksOf(new Map())).toEqual({ hrefs: [], lifeLinks: [] });
});

test("an ending quotes its later words: an episode's where plain and dated, a later line's linked to its unit read", () => {
  const o = line({ text: "Send the quote." });
  const later = line({ quote: "Sent it today.", unit: "unit_000000000002" });
  const matter = {
    id: "matter_aaaaaaaaaaaa",
    lone: false,
    name: "Send the quote",
    open: true,
    owedTo: [],
    projects: [] as string[],
    status: "moving" as const,
    steps: stepsOf(o.id),
    waitingOn: [],
    with: [],
  };
  const endedBy = (by: string, where: CheckInputs["where"]) =>
    checksOf(
      inputs([o, later], {
        endings: new Map([[o.id, { later: by, quote: "Sent it." }]]),
        kept: new Set(),
        matters: [matter],
        where,
      })
    )[0]?.context;
  expect(
    endedBy("ep_000000000001", new Map([["ep_000000000001", "a day, 2 Oct"]]))
  ).toEndWith("\n\n> Sent it.\n\n*a day, 2 Oct*");
  expect(
    endedBy(later.id, new Map([["unit_000000000002", "whatsapp, 1 Oct"]]))
  ).toEndWith("\n\n> Sent it.\n\n*[whatsapp, 1 Oct](life:unit_000000000002)*");
});

test("a name's unit is read with the cards' sentences, so its quote can link it", async () => {
  const units = spyOn(files, "readUnitsFor").mockReturnValue([]);
  try {
    await readSentences({
      lines: [],
      names: [
        {
          key: "dre",
          last: line({ unit: "unit_00000000000d" }),
          lines: [],
          names: ["Dre"],
        },
      ] as never,
      people: { inferred: [] } as unknown as People,
      steps: new Set(),
    });
    // The last read is the sentences' own, whose units make where each was said (`CheckInputs.where`).
    expect(units.mock.calls.at(-1)?.[0]).toContain("unit_00000000000d");
  } finally {
    units.mockRestore();
  }
});
