import { expect, test } from "bun:test";
import { checksOf } from "./checks";
import { inputs, line, stepsOf } from "./checks-test-inputs";
import type { CheckMatter } from "./life-checks";

const matterOf = (o: { id: string }, id: string, important?: true) => ({
  id,
  important,
  lone: false,
  name: `Matter ${id.slice(-1)}`,
  open: true,
  owedTo: [],
  projects: [] as string[],
  status: "moving" as const,
  steps: stepsOf(o.id),
  waitingOn: [],
  with: [],
});

test("a card's matter carries his important mark, in `matter` and `onMatters`; an unmarked one has none on the wire", () => {
  const marked = line({ id: "obs_aaaaaaaaaaaa", text: "Send the quote." });
  const plain = line({ id: "obs_bbbbbbbbbbbb", text: "Call the bank." });
  const base = inputs([marked, plain], {
    endings: new Map([
      [marked.id, { later: "ep_000000000001", quote: "Sent it." }],
      [plain.id, { later: "ep_000000000002", quote: "Called." }],
    ]),
    kept: new Set(),
    matters: [
      matterOf(marked, "matter_aaaaaaaaaaaa", true),
      matterOf(plain, "matter_bbbbbbbbbbbb"),
    ],
  });
  const byRef = new Map(checksOf(base).map((c) => [c.ref, c]));
  const card = byRef.get(marked.id);
  const shown: CheckMatter = {
    id: "matter_aaaaaaaaaaaa",
    important: true,
    name: "Matter a",
  };
  expect(card?.matter).toEqual(shown);
  expect(card?.onMatters).toEqual([shown]);
  const other = byRef.get(plain.id);
  // On the wire (JSON) an unmarked matter has no `important` key at all.
  expect(JSON.parse(JSON.stringify(other?.matter))).toEqual({
    id: "matter_bbbbbbbbbbbb",
    name: "Matter b",
  });
});
