import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { setSettings } from "../core/settings";
import { agentInRole } from "../host/desk-read";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as inbox from "../host/inbox";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matterRows from "../host/matter-rows";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matters from "../memory/matters";
import { readCorrections, readLedger } from "../memory/memory-files";
import { register } from "./agent-actions";
import { askedOf, callDoorOf, setup } from "./test-desk";

// Ask Life's `show` and the two asks that go through acts already there: made-up matters, people and words.

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

// His "show me…": `show` puts a page or a cut list on his phone with the answer, changing nothing; every row and page
// is checked against Life's own reads when shown.
test("`show` carries a list cut to rows Life shows, or a page, with the answer; an unknown row, page or project is refused; it needs no `said`", async () => {
  const rows = spyOn(matterRows, "readMatterRowsNow").mockResolvedValue({
    matters: [{ id: lawyer.id }, { id: "matter_cccccccccccc" }],
  } as never);
  const people = spyOn(
    matterRows,
    "readPeopleAndOrganizations"
  ).mockResolvedValue({ people: [{ ref: "person:test-ana" }] } as never);
  const checks = spyOn(inbox, "openChecksNow").mockResolvedValue([
    { ref: "dec_000000000001" },
  ] as never);
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    lawyer,
  ] as never);
  const other = register(t.desk, {
    brief: "Test shop agent",
    folder: t.dir,
    runtime: "claude",
  });
  const asks = readLedger().length;
  try {
    const refused: Record<string, string> = {};
    const top = {
      kind: "list" as const,
      label: "Your 2 most important today",
      list: "matters" as const,
      refs: ["matter_cccccccccccc", lawyer.id],
    };
    const shown = await asked(
      "Show my 2 most important matters for today",
      async (r) => {
        const id = main()?.id ?? "";
        const show = (s: unknown) => callDoor(id, "show", { show: s });
        refused.matter = await show({ ...top, refs: ["matter_dddddddddddd"] });
        refused.ask = await show({
          kind: "list",
          label: "x",
          list: "checks",
          refs: ["dec_000000000009"],
        });
        refused.people = await show({
          kind: "list",
          label: "x",
          list: "people",
          refs: ["person:test-ana", "person:test-nobody"],
        });
        // A person or organization Life knows opens; a later call replaces it.
        expect(
          await show({ id: "person:test-ana", kind: "page", page: "person" })
        ).not.toContain("Not done");
        refused.person = await show({
          id: "matter_cccccccccccc",
          kind: "page",
          page: "person",
        });
        refused.project = await show({
          id: "no-such-project",
          kind: "page",
          page: "project",
        });
        refused.main = await show({ id, kind: "page", page: "agent" });
        refused.filter = await show({ ...top, list: "status" });
        expect(
          await show({ id: other, kind: "page", page: "agent" })
        ).not.toContain("Not done");
        // A later call replaces it.
        expect(await show(top)).not.toContain("Not done");
        t.fake.hear(r, { kind: "words", text: "Your **two** first." });
      }
    );
    expect(shown.answer).toEqual({
      kind: "reply",
      show: top,
      words: "Your **two** first.",
    });
    expect(refused.matter).toContain("not among the matters his phone shows");
    expect(refused.ask).toContain("not among the checks his phone shows");
    expect(refused.people).toContain(
      "person:test-nobody: not among the people his phone shows"
    );
    expect(refused.person).toContain("is not a person");
    expect(refused.project).toContain("is not a project of his");
    expect(refused.main).toContain("is not an agent of his");
    expect(refused.filter).toContain("Invalid");
    // No other agent has it, and nothing was written.
    expect(
      await callDoor(other, "show", { show: { ...top, refs: [lawyer.id] } })
    ).toContain("the main session's alone");
    expect(readLedger().length).toBe(asks);
  } finally {
    rows.mockRestore();
    people.mockRestore();
    checks.mockRestore();
    book.mockRestore();
  }
});

// His word that a payment is made ("I paid the lawyer") ends the matter by his word (`endByHisWord`), his words its
// note; his question at a place ("I'm at the shop, what do I need again?") answers the next step and shows its matter.
test("“I paid the lawyer” closes the matter's open steps with his words; “what do I need again?” answers and shows the matter", async () => {
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
      t.fake.hear(r, { kind: "words", text: "**Done**: the lawyer is paid." });
    });
    expect(paid.answer).toEqual({
      kind: "done",
      matter: lawyer.id,
      words: "**Done**: the lawyer is paid.",
    });
    expect(readCorrections().at(-1)).toMatchObject({
      kind: "outdated",
      note: "I paid the lawyer",
      observations: ["obs_000000000002"],
    });
    const page = {
      id: lawyer.id,
      kind: "page" as const,
      page: "matter" as const,
    };
    const there = await asked(
      "I've arrived at the lawyer's, what do I need to do again?",
      async (r) => {
        const id = main()?.id ?? "";
        await callDoor(id, "answer", { sources: [lawyer.id] });
        expect(await callDoor(id, "show", { show: page })).not.toContain(
          "Not done"
        );
        t.fake.hear(r, { kind: "words", text: "**Pay** the lawyer." });
      }
    );
    expect(there.answer).toEqual({
      kind: "reply",
      show: page,
      sources: [lawyer.id],
      words: "**Pay** the lawyer.",
    });
  } finally {
    book.mockRestore();
  }
});
