import { expect, test } from "bun:test";
import type { StoredMoveRate } from "./move-rates-file";
import { moveRatesBlock } from "./read-person-page";

const row = (
  thing: string,
  extra: Partial<StoredMoveRate> = {}
): StoredMoveRate => ({
  above: 12,
  all: { n: 51, of: 150 },
  among: 27,
  before: { n: 31, of: 100 },
  below: 15,
  lately: { n: 20, of: 50 },
  says: "share",
  thing,
  ...extra,
});
const rates = {
  at: "2026-11-13T07:00:00.000Z",
  exchanges: 412,
  rows: [
    row("asks_about", { side: "me", source: "whatsapp" }),
    row("asks_about", {
      above: 15,
      all: { n: 42, of: 150 },
      lately: { n: 4, of: 14 },
      side: "them",
      source: "whatsapp",
    }),
    row("tension", { source: "whatsapp" }),
    row("toward", { side: "me" }),
    row("apologises", { side: "me" }),
    row("directs", { side: "me" }),
    row("directs", { side: "them" }),
    // Not proven: raw counts only.
    row("yields", { all: { n: 3, of: 29 }, says: "exploratory", side: "me" }),
    row("yields", {
      all: { n: 10, of: 94 },
      says: "exploratory",
      side: "them",
    }),
    row("blames", {
      all: { n: 4, of: 1016 },
      says: "exploratory",
      side: "me",
      source: "whatsapp",
    }),
  ],
};

test("the person read shows the shares by chance, then the conduct counted but not proven", () => {
  expect(moveRatesBlock(rates)).toEqual([
    "## Counted from their one-to-one chats (Life's reads, built 2026-11-13; 412 exchanges read)",
    "Each line: share of chances (n/of) all years; last 12 months | before; N of M other people are higher. Low, unremarkable lines are left out.",
    "Legend: toward = took up the other's bid; warm = the exchange read warm on that side; tension, conflict = the exchange held some.",
    "Per exchange each wrote in, whatsapp:",
    "- asks_about: he 34% (51/150; 40% | 31%; 12 of 27 higher), they 28% (42/150; - | 31%; 15 of 27 higher)",
    "- tension: 34% (51/150; 40% | 31%; 12 of 27 higher)",
    "Of the other's bids:",
    "- toward: he 34% (51/150; 40% | 31%; 12 of 27 higher)",
    "When the other raises a fault:",
    "- apologises: he 34% (51/150; 40% | 31%; 12 of 27 higher)",
    "When something is decided:",
    "- directs: he 34% (51/150; 40% | 31%; 12 of 27 higher), they 34% (51/150; 40% | 31%; 12 of 27 higher)",
    "Counted, not proven (raw counts only: two models agree too little on these, or the test had too few cases):",
    "- yields (when the other raises a fault): he 3/29, they 10/94",
    "- blames (per exchange, whatsapp): he 4/1016",
    "",
  ]);
});

test("a channel with nothing lately is named, not shown; a low unremarkable line is dropped, a low one at an extreme kept", () => {
  const low = { above: 10, all: { n: 2, of: 150 }, below: 10 };
  const block = moveRatesBlock({
    ...rates,
    rows: [
      row("tension", { source: "whatsapp" }),
      row("tension", {
        all: { n: 5, of: 80 },
        lately: { n: 0, of: 0 },
        source: "mail",
      }),
      row("asks_about", { side: "me", source: "mail" }),
      row("thanks", { ...low, side: "me", source: "whatsapp" }),
      row("gives", { ...low, above: 1, side: "me", source: "whatsapp" }),
    ],
  });
  expect(block.slice(3)).toEqual([
    "Not shown: mail (80 exchanges, none lately)",
    "Per exchange each wrote in, whatsapp:",
    "- tension: 34% (51/150; 40% | 31%; 12 of 27 higher)",
    "- gives: he 1% (2/150; 40% | 31%; 1 of 27 higher)",
    "",
  ]);
});

test("a person with no rows, or no file, has no block", () => {
  expect(moveRatesBlock({ ...rates, rows: [] })).toEqual([]);
  expect(moveRatesBlock(null)).toEqual([]);
});
