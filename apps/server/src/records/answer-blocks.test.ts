import { expect, test } from "bun:test";
import {
  type AnswerBlock,
  blockSplitter,
  valueProblemOf,
} from "./answer-blocks";

// The answer's blocks: a written value must be in its source whole, and no `life:` fence reaches his phone as words.
// Made-up receipts.

const SOURCE =
  "Bead House, 2026-11-20. Tila 19 bags, Half Tila 14 bags. Total 14,820 baht.";
const table = (rows: (string | number)[][]): AnswerBlock => ({
  body: { columns: ["Bead", "Bags"], from: "life:obs_000000000001", rows },
  kind: "table",
});

test('a number is matched whole: 820, 11 from a date, and "4,820" as text are not in a source that writes 14,820', () => {
  expect(valueProblemOf(table([["Tila", 19]]), SOURCE)).toBeUndefined();
  expect(valueProblemOf(table([["Total", 14_820]]), SOURCE)).toBeUndefined();
  expect(valueProblemOf(table([["Total", "14,820"]]), SOURCE)).toBeUndefined();
  expect(valueProblemOf(table([["Total", 820]]), SOURCE)).toBeDefined();
  expect(valueProblemOf(table([["Total", "4,820"]]), SOURCE)).toBeDefined();
  expect(valueProblemOf(table([["Day", 11]]), SOURCE)).toBeDefined();
  // A number keeps its sign: money in is never money out.
  expect(valueProblemOf(table([["Refund", "-4,820"]]), SOURCE)).toBeDefined();
  expect(valueProblemOf(table([["Refund", -14_820]]), SOURCE)).toBeDefined();
  expect(
    valueProblemOf(table([["Refund", -3]]), "Refund (-3 bags)")
  ).toBeUndefined();
  expect(
    valueProblemOf(table([["Bags", 3]]), "Refund (-3 bags)")
  ).toBeDefined();
  // Text matches whole words only.
  expect(valueProblemOf(table([["Half Tila", 14]]), SOURCE)).toBeUndefined();
  expect(valueProblemOf(table([["alf Til", 14]]), SOURCE)).toBeDefined();
});

/** What a splitter hears of `chunks`: its words and its blocks' kinds. */
function split(chunks: string[]) {
  const heard = { blocks: [] as string[], words: "" };
  const s = blockSplitter({
    block: (f, isOpen) => heard.blocks.push(isOpen ? `open ${f.kind}` : f.kind),
    words: (t) => {
      heard.words += t;
    },
  });
  for (const c of chunks) {
    s.push(c);
  }
  s.end();
  return heard;
}

test("every `life:` fence is a block, never words: indented (its space a chunk of its own), tildes, words after its kind", () => {
  const body = '{"answers":["Yes","No"]}';
  expect(
    split(["Hi.\n", " ", "```life:question\n", body, "\n```\nBye."])
  ).toEqual({
    blocks: ["question"],
    words: "Hi.\nBye.",
  });
  expect(split([`~~~life:question\n${body}\n~~~\n`])).toEqual({
    blocks: ["question"],
    words: "",
  });
  expect(split([`\`\`\`\` life:question json\n${body}\n\`\`\`\`\n`])).toEqual({
    blocks: ["question"],
    words: "",
  });
  // Closed by the same character only; never closed, it is a miss, not words.
  expect(split([`~~~life:question\n${body}\n\`\`\`\n`])).toEqual({
    blocks: ["open question"],
    words: "",
  });
  // Inside a blockquote, a fence is a block too, its body with it.
  expect(
    split([`Look:\n> \`\`\`life:question\n> ${body}\n> \`\`\`\nDone.`])
  ).toEqual({ blocks: ["question"], words: "Look:\nDone." });
  // A marker split across chunks mid-line is still seen whole: its line is dropped, the words before it stream.
  expect(split(["Here ``", "`li", "fe:table\n", "Next."])).toEqual({
    blocks: [],
    words: "Here Next.",
  });
  // A marker that is no fence (mid-line) is dropped from the words; ordinary code stays.
  expect(split(["See ```life:table here\n```js\nx\n```\n"])).toEqual({
    blocks: [],
    words: "```js\nx\n```\n",
  });
});
