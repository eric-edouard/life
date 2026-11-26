import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { setSettings } from "../core/settings";
import { agentInRole } from "../host/desk-read";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as inbox from "../host/inbox";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as findRefs from "../memory/find-refs";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matters from "../memory/matters";
import { readCorrections } from "../memory/memory-files";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as openByIdModule from "../memory/open-by-id";
import { openAssignment, register } from "./agent-actions";
import { ownAssignmentOf } from "./role-agents";
import { askedOf, callDoorOf, setup } from "./test-desk";

// Ask Life's answers: Markdown with Life's blocks, each checked before his phone draws it; and an ask through an act
// already there. Made-up matters, receipts and words.

let t = setup();
beforeEach(() => {
  t = setup();
  t.desk.runtimes = { claude: t.fake.runtime };
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
});
afterAll(() => setSettings({ desk: null }));

const main = () => agentInRole(t.desk.db, "main");
const asked = (words: string, play: (ref: string) => unknown) =>
  askedOf(t, words, play);
const callDoor = (id: string, name: string, args: unknown) =>
  callDoorOf(t, id, name, args);

/** A made-up running matter with one open promise, as the matter book gives it. */
const lawyer = {
  id: "matter_bbbbbbbbbbbb",
  name: "Pay the test lawyer",
  open: true,
  steps: [
    {
      at: "2026-11-10T10:00:00.000Z",
      day: "2026-11-10",
      kind: "promise",
      quote: "I'll pay the lawyer",
      ref: "obs_000000000002",
      text: "Pay the lawyer",
    },
  ],
};

/** A fenced block of kind `kind` holding `body`, as the session writes it. */
const fenced = (kind: string, body: unknown) =>
  `\`\`\`life:${kind}\n${JSON.stringify(body)}\n\`\`\`\n`;

// The plan's critical case: a value the session writes that its `from` does not hold never reaches his phone.
test("a table whose number is not in its source is dropped and its words stand; one that matches is drawn, its total the sum of its last column", async () => {
  const shown = spyOn(openByIdModule, "openById").mockResolvedValue(
    "Bead House receipt: Tila 19 bags, Half Tila 14 bags. Total 4,820 baht."
  );
  const refs = spyOn(findRefs, "refsProblemOf").mockResolvedValue(undefined);
  try {
    const good = {
      columns: ["Bead", "Bags"],
      from: "life:msg:whatsapp|m1",
      rows: [
        ["Tila", 19],
        ["Half Tila", 14],
      ],
      total: 33,
    };
    const wrong = {
      ...good,
      rows: [
        ["Tila", 21],
        ["Half Tila", 14],
      ],
    };
    const badTotal = { ...good, total: 34 };
    const { answer, lines } = await asked("How many bags?", (r) => {
      // Chunks split mid-fence, as a stream comes.
      const text = `Twelve bags in all.\n${fenced("table", wrong)}${fenced("table", badTotal)}${fenced("table", good)}Paid 4,820.`;
      for (let i = 0; i < text.length; i += 7) {
        t.fake.hear(r, { kind: "words", text: text.slice(i, i + 7) });
      }
    });
    expect(lines.filter((l) => l.kind === "block")).toEqual([
      { block: good, kind: "block", type: "table" },
    ]);
    expect(answer).toMatchObject({
      kind: "reply",
      refs: ["msg:whatsapp|m1"],
      text: `Twelve bags in all.\n${fenced("table", good)}Paid 4,820.`,
    });
    // The words his phone was streamed never hold a fence.
    expect(
      lines.flatMap((l) => (l.kind === "words" ? [l.text] : [])).join("")
    ).toBe("Twelve bags in all.\nPaid 4,820.");
  } finally {
    shown.mockRestore();
    refs.mockRestore();
  }
});

// His word that a payment is made ("I paid the lawyer") ends the matter by his word (`endByHisWord`), his words its
// note; his question at a place ("I'm at the shop, what do I need again?") answers the next step under its matter's item.
test("“I paid the lawyer” closes the matter's open steps with his words; “what do I need again?” answers under the matter's item; an item that opens nothing is dropped", async () => {
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    lawyer,
  ] as never);
  try {
    const paid = await asked("I paid the lawyer this morning", async (r) => {
      expect(
        await callDoor(main()?.id ?? "", "correct_memory", {
          correction: { kind: "outdated", matter: lawyer.id },
          said: "I paid the lawyer",
        })
      ).not.toContain("Not done");
      t.fake.hear(r, { kind: "words", text: "👍" });
    });
    expect(paid.answer).toMatchObject({
      acts: [{ kind: "done", matter: lawyer.id }],
      reaction: "👍",
      text: "",
    });
    expect(readCorrections().at(-1)).toMatchObject({
      kind: "outdated",
      note: "I paid the lawyer",
      observations: ["obs_000000000002"],
    });
    const there = await asked(
      "I've arrived at the lawyer's, what do I need to do again?",
      async (r) => {
        // The same kept session: let this ask reach it first.
        await Bun.sleep(10);
        t.fake.hear(r, {
          kind: "words",
          text: `**Pay** the lawyer.\n${fenced("items", [`life:${lawyer.id}`])}${fenced("items", ["life:obs_doesnotexist"])}`,
        });
      }
    );
    expect(there.answer).toMatchObject({
      refs: [lawyer.id],
      text: `**Pay** the lawyer.\n${fenced("items", [`life:${lawyer.id}`])}`.trim(),
    });
  } finally {
    book.mockRestore();
  }
});

// Owner-reported (26 Nov 2026): "what's waiting on me?" lost its items, a fix ask's ref being no card, matter or step.
test("an items block citing an open ask by its inbox ref is drawn; one citing an ask not open is dropped", async () => {
  const open = spyOn(inbox, "openChecksNow").mockResolvedValue([
    { ref: "fix:signed-out/line" },
  ] as Awaited<ReturnType<typeof inbox.openChecksNow>>);
  try {
    const { answer } = await asked("What's waiting on me?", (r) =>
      t.fake.hear(r, {
        kind: "words",
        text: `One thing.\n${fenced("items", ["life:fix:signed-out/line"])}${fenced("items", ["life:fix:signed-out/telegram"])}`,
      })
    );
    expect(answer).toMatchObject({
      refs: ["fix:signed-out/line"],
      text: `One thing.\n${fenced("items", ["life:fix:signed-out/line"])}`.trim(),
    });
  } finally {
    open.mockRestore();
  }
});

// An agent's reply enters the main session as data: an act still takes `said` from his words of this ask alone.
test("a question to an agent returns its reply as data; an act refuses `said` taken from that reply", async () => {
  const plumber = register(t.desk, {
    brief: "Test plumber agent",
    folder: t.dir,
    runtime: "claude",
  });
  if (!ownAssignmentOf(t.desk.db, plumber)) {
    openAssignment(t.desk, plumber, { openedBy: "owner" });
  }
  const place = ownAssignmentOf(t.desk.db, plumber) ?? "";
  await asked("Where are we with the plumber?", async (r) => {
    const id = main()?.id ?? "";
    const asking = callDoor(id, "tell_agent", {
      agent: plumber,
      kind: "question",
      said: "Where are we with the plumber",
    });
    await Bun.sleep(10);
    const question =
      t.desk.db
        .query<{ event_id: string }, [string]>(
          "select event_id from event where assignment_id = ? and name = 'main_question'"
        )
        .get(place)?.event_id ?? "";
    expect(await callDoor(plumber, "read_question", { question })).toContain(
      "Where are we with the plumber"
    );
    await callDoor(plumber, "answer_question", {
      question,
      text: "The plumber comes on Tuesday at nine.",
    });
    expect(await asking).toContain("The plumber comes on Tuesday at nine.");
    expect(
      await callDoor(id, "tell_life", {
        said: "The plumber comes on Tuesday at nine",
      })
    ).toContain("must be his own words of this ask");
    t.fake.hear(r, { kind: "words", text: "Tuesday at nine." });
  });
});
