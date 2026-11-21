import { expect, spyOn, test } from "bun:test";
import type { CheckInputs } from "./check-context";
import { readSentences } from "./check-sentences";
import { checksOf } from "./checks";
import { about, inputs, line, nameRow, stepsOf } from "./checks-test-inputs";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as files from "./memory-files";
import type { People } from "./who";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as words from "./words";

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

test("a name's unit is read once, with the cards' sentences, and its quote links it", async () => {
  const held = line({ quote: "Dre fixed it", unit: "unit_00000000000d" });
  const units = spyOn(files, "readUnitsFor").mockReturnValue([
    {
      date: "2026-10-01",
      hash: "hd",
      id: "unit_00000000000d",
      key: "chat-d",
      source: "whatsapp",
      title: "chat-d",
    },
  ] as never);
  const read = spyOn(words, "unitLines").mockResolvedValue({
    built: {},
    lines: [],
  } as never);
  try {
    const { where } = await readSentences({
      lines: [],
      names: [{ key: "dre", last: held, lines: [], names: ["Dre"] }] as never,
      people: { inferred: [] } as unknown as People,
      steps: new Set(),
    });
    expect(units.mock.calls).toEqual([[["unit_00000000000d"]]]);
    const [name] = checksOf({
      ...inputs([held], { unresolved: [nameRow("Dre", held.id)] }),
      where,
    });
    expect(name?.context).toBe(
      "> Dre fixed it\n\n*[whatsapp, 1 Oct](life:unit_00000000000d)*"
    );
    expect(name?.lifeLinks).toEqual([
      { kind: "unit", ref: "unit_00000000000d" },
    ]);
  } finally {
    units.mockRestore();
    read.mockRestore();
  }
});

test("a quote keeps its lines, each literal: a hard break between them, no recorded link or table", () => {
  const base = inputs([about(REF)], { inferred: [ID] });
  const people = {
    ...base.people,
    inferred: base.people.inferred.map((p) => ({
      ...p,
      evidence: [
        {
          quote: "Here it is:\n[the form](https://form.example) | a | b |",
          unit: "unit_000000000001",
        },
      ],
    })),
  };
  const [check] = checksOf({
    ...base,
    people,
    where: new Map([["unit_000000000001", "whatsapp, 2 Oct"]]),
  });
  const html = Bun.markdown.html(check?.context ?? "", { autolinks: true });
  expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([
    "life:unit_000000000001",
  ]);
  expect(html).toContain(
    "<blockquote>\n<p>Here it is:<br />\n[the form](https://form.example) | a | b |</p>\n</blockquote>"
  );
});
