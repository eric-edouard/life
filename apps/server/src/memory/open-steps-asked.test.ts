import { expect, test } from "bun:test";
import type { Observation } from "../records/observation";
import { checksOf } from "./checks";
import { holdOn, inputs } from "./checks-test-inputs";
import { type MatterRecords, matterBookOf } from "./matter-read";
import { succeedsOf } from "./matters";
import { OWNER } from "./read-truth";
import { OWED_BY_HIM } from "./your-move";

// The rule (his word of 27 Nov 2026): an open step of his stays asked until there is evidence it ended, or his word.
// One walk from the records to his inbox over every path that once hid one: a re-read, a to-do item in his list, a
// reading of "over" citing nothing, a missed day, a quiet matter, a mailer's notice, a stopped agent. Made-up matters.

const TODAY = "2026-11-20";
const pad = (n: number) => String(n).padStart(12, "0");
const step = (n: number, over: Partial<Observation> = {}) =>
  ({
    area: null,
    at: "2026-10-01T09:00:00.000Z",
    date: "2026-10-01",
    id: `obs_${pad(n)}`,
    importance: 2,
    quote: "I'll sort it",
    source: { channel: "whatsapp", ref: `msg-${n}` },
    speaker: OWNER,
    subjects: [OWNER],
    text: `Sort errand ${n}`,
    type: "to_do",
    unit: `unit_${pad(n)}`,
    when: null,
    ...over,
  }) as Observation;
const matter = (n: number, refs: string[]) => ({
  areas: [],
  id: `matter_${pad(n)}`,
  name: `Errand ${n}`,
  projects: [],
  steps: refs.map((ref) => ({ ref })),
});

// A re-read: the matter names the first reading; the unit read again gives the same line a new id.
const first = step(1);
const reread = step(2, { source: first.source, text: "Sort errand 1, again" });
const missed = step(3, { when: "2026-11-05" });
const quiet = step(4, { at: "2026-08-01T09:00:00.000Z", date: "2026-08-01" });
const mailer = step(5, { speaker: "unknown:no-reply@shop.test" });
const overNoProof = step(6);
const byStopped = step(7, { type: "promise" });
const ITEM = "entry_000000000008";

const records: MatterRecords = {
  current: new Set(),
  directions: [
    {
      at: "2026-11-01T02:00:00Z",
      by: "life",
      endingRecords: [],
      goal: "Errand 6 is sorted",
      steps: [overNoProof.id],
    },
  ],
  episodeOf: new Map(),
  icons: [],
  important: [],
  isMailer: (r) => r === mailer.speaker,
  ledger: [],
  linkEndings: new Map(),
  observations: succeedsOf(
    [reread, missed, quiet, mailer, overNoProof, byStopped],
    [first]
  ),
  projects: [],
  refOf: (r) => r,
  retired: new Map(),
  todoItems: [
    {
      at: "2026-09-01T09:00:00.000Z",
      fields: { title: "Renew the bike papers" },
      key: ITEM,
    },
  ],
};

test("every open step of his is asked, or has a recorded ending", () => {
  const book = matterBookOf(
    {
      matters: [
        matter(1, [first.id]),
        matter(3, [missed.id]),
        matter(4, [quiet.id]),
        matter(5, [mailer.id]),
        matter(6, [overNoProof.id]),
        matter(7, [byStopped.id]),
      ],
      // The first reading was shown to a matters call: its successor counts as shown.
      offered: new Set([first.id]),
    },
    records,
    TODAY
  );
  const checks = checksOf(
    inputs([], {
      heldByAgents: [holdOn(byStopped.id, { status: "stopped" })],
      matters: book,
      today: TODAY,
    })
  );
  const asked = new Set(checks.flatMap((c) => c.ridesOn.matterIds));
  const his = book.flatMap((v) =>
    v.steps
      .filter((s) => OWED_BY_HIM.includes(s.kind) && !s.ending)
      .map((s) => [s.ref, asked.has(v.id)] as const)
  );
  // Each step of his the records hold is in the book, open, and its matter asked.
  expect(his.toSorted()).toEqual(
    [reread, missed, quiet, mailer, overNoProof, byStopped]
      .map((o) => [o.id, true] as const)
      .concat([[ITEM, true]])
      .toSorted()
  );
  // A missed day asks with it as the deadline.
  expect(
    checks.find((c) => c.subject === missed.id)?.deadline?.slice(0, 10)
  ).toBe("2026-11-05");
});

test("a re-read takes over each earlier reading of its line, never another line's", () => {
  const other = step(9);
  expect(
    succeedsOf([reread, other], [first]).map((o) => o.succeeds)
  ).toEqual([[first.id], undefined]);
});
