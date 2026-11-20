import { expect, test } from "bun:test";
import { checksOf } from "./checks";
import { inputs, line, stepsOf } from "./checks-test-inputs";
import { OWNER } from "./read-truth";

test("no ending check when the link rests on his own later words; the other person's later words are asked", () => {
  const o = line({ text: "Send the quote." });
  const matter = {
    id: "matter_bbbbbbbbbbbb",
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
  const withLater = (speaker: string) => {
    const later = line({ speaker, text: "The quote is sent." });
    return inputs([o, later], {
      endings: new Map([[o.id, { later: later.id, quote: "Sent it." }]]),
      kept: new Set(),
      matters: [matter],
    });
  };
  expect(checksOf(withLater(OWNER))).toEqual([]);
  expect(checksOf(withLater("unknown:Camille")).map((x) => x.kind)).toEqual([
    "ending",
  ]);
});
