import { expect, test } from "bun:test";
import { partsOf } from "./situation-parts";

const A = "ep_aaaaaaaaaaaa";
const B = "ep_bbbbbbbbbbbb";
const input = {
  episodes: [
    { id: A, what: "Sam said: we should repaint the kitchen in spring." },
  ],
};
const shown = new Set([A, "person:test-sam"]);
const part = (markdown: string, cites: string[] = [A]) => ({ cites, markdown });

test("a reply keeps only parts resting on what the call was shown, and nothing a reading may not hold", () => {
  const kept = [
    part("You met Sam at work in 2019.", ["person:test-sam"]),
    part("On 3 Nov, [Sam](life:ep_aaaaaaaaaaaa) asked about the kitchen."),
    part("> we should repaint the kitchen in spring"),
  ];
  const dropped = [
    part("Cites one it was not shown.", [A, B]),
    part("Links one it was not shown: [here](life:ep_bbbbbbbbbbbb)."),
    part('Sam said "we should sell the flat in spring".'),
    part("## A heading"),
    part("```life:question\n{}\n```"),
    part("See https://example.com for more."),
    part("![a photo](life:ep_aaaaaaaaaaaa)"),
    { markdown: "No cites at all." },
  ];
  expect(partsOf({ parts: [...kept, ...dropped] }, shown, input)).toEqual(kept);
});

test("a reply with no part kept is a failed call: it throws, so the last situation stays", () => {
  expect(() =>
    partsOf({ parts: [part("Cites nothing shown.", [B])] }, shown, input)
  ).toThrow();
  expect(() => partsOf("not json", shown, input)).toThrow();
});
