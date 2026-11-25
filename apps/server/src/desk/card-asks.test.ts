import { afterEach, expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { assignmentOf } from "../host/desk-read";
import { decisionCardOf } from "../memory/checks";
import { decisionsNow, requestDecision } from "../memory/decisions";
import { INSTRUCTIONS, recordInstruction } from "../memory/instructions";
import { askDecision, finish, openAssignment, register } from "./agent-actions";
import { answerQuestion, askAssignment, readQuestion } from "./agent-questions";
import { ahead, matterView, on, setup, withMatters } from "./test-desk";
import { turnRefusalOf } from "./turn-refusal";

// An agent's cards (bundle A of v4): no plan card; every card writes `ask`, `recommended` and `follow`; a plan is an
// optional body; his instructions refuse a draft; the same subject is never asked twice unanswered without `changed`.

afterEach(() => rmSync(INSTRUCTIONS, { force: true }));

/** The fields every agent's card writes. */
const FIELDS = { ask: "Decide it", follow: [], recommended: "go" };

test("an agent's card is refused without `ask`, `recommended` or `follow`, or with a `recommended` no option has; `edits` only with a draft, from any asker", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const card = (over: Record<string, unknown> = {}) => ({
    ...FIELDS,
    context: "Kit quoted 80 €.",
    deadline: ahead(DAY),
    onSilence: null,
    options: [
      { id: "go", label: "Go" },
      { id: "no", label: "Not now" },
    ],
    question: "Go ahead?",
    title: "Mend the watch",
    ...over,
  });
  const refusals = await Promise.allSettled([
    askDecision(desk, on(desk, agent), card({ ask: undefined })),
    askDecision(
      desk,
      on(desk, agent),
      card({ follow: undefined, recommended: undefined })
    ),
    askDecision(desk, on(desk, agent), card({ recommended: "maybe" })),
    requestDecision(DESK_AGENT, { ...card({ edits: ["Warmer"] }), agent }),
  ]);
  expect(
    refusals.map((r) => r.status === "rejected" && String(r.reason))
  ).toEqual([
    expect.stringContaining("a card writes `ask`:"),
    expect.stringContaining("a card writes `recommended`, `follow`:"),
    expect.stringContaining("`recommended` is one of the options' ids"),
    expect.stringContaining("`edits` go only with a `draft`"),
  ]);
  const { id } = await askDecision(desk, on(desk, agent), card());
  expect(decisionsNow().find((d) => d.id === id)).toMatchObject(FIELDS);
  setSystemTime();
});

test("a plan is an optional body of any card: its steps and what they were gathered from reach his card", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const plan = [
    {
      by: "agent",
      channel: "whatsapp",
      text: "Ask Kit for the quote",
      when: "today",
    },
    { by: "owner", channel: "payment", text: "Pay the deposit" },
  ];
  const { id } = await askDecision(desk, on(desk, agent), {
    ...FIELDS,
    context: "What I read:\n- Kit's quote, 80 €",
    deadline: ahead(DAY),
    gathered: { text: "From Kit's quote and two others" },
    onSilence: null,
    options: [
      { id: "go", label: "Book it" },
      { id: "no", label: "Not now" },
    ],
    plan,
    question: "Book the repair?",
    title: "Mend the watch",
  });
  const d = decisionsNow().find((x) => x.id === id);
  expect(d && decisionCardOf(d)).toMatchObject({
    gathered: { text: "From Kit's quote and two others" },
    options: [{ id: "go" }, { id: "no" }],
    plan,
  });
  await expect(
    requestDecision(DESK_AGENT, {
      context: "x",
      deadline: ahead(DAY),
      gathered: { text: "From the quote" },
      onSilence: null,
      options: [
        { id: "go", label: "Go" },
        { id: "no", label: "Not now" },
      ],
      question: "Go?",
      title: "t",
    })
  ).rejects.toThrow("`gathered` goes with `plan`");
  setSystemTime();
});

test("his `no-drafts` refuses a draft to that person; the same subject unanswered is asked again only with `changed`", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const s = assignmentOf(
    desk.db,
    openAssignment(desk, agent, { openedBy: "desk", steps: ["obs_test_kit"] })
  );
  if (!s) {
    throw new Error("no assignment");
  }
  const views = [matterView("mat_test_kit", ["obs_test_kit"])];
  recordInstruction({
    effect: "no-drafts",
    said: "made-up words of his",
    scope: "person:kit",
    text: "Never draft to Kit",
  });
  const card = (over: Record<string, unknown> = {}) => ({
    ...FIELDS,
    context: "Kit asked for the deposit.",
    deadline: ahead(DAY),
    onSilence: null,
    options: [
      { id: "go", label: "Go" },
      { id: "no", label: "Not now" },
    ],
    question: "Pay the deposit?",
    subject: "obs_test_kit",
    title: "Mend the watch",
    ...over,
  });
  await expect(
    withMatters(views, () =>
      askDecision(
        desk,
        s,
        card({
          draft: { channel: "whatsapp", text: "Hi Kit", to: "person:kit" },
          options: [
            { id: "go", label: "Send it", outgoing: true },
            { id: "no", label: "Not now" },
          ],
        })
      )
    )
  ).rejects.toThrow("he asked Life to draft no replies here");
  const first = await withMatters(views, () => askDecision(desk, s, card()));
  await askDecision(desk, s, { why: "made-up", withdraw: first.id });
  await expect(
    withMatters(views, () => askDecision(desk, s, card()))
  ).rejects.toThrow("ask again only with `changed`");
  await expect(
    withMatters(views, () =>
      askDecision(desk, s, card({ changed: ["deadline"] }))
    )
  ).resolves.toMatchObject({ id: expect.any(String) });
  setSystemTime();
});

test("an assignment woken on an arrival that needs nothing finishes with no card, asking and sending nothing", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const id = openAssignment(desk, agent, {
    openedBy: "desk",
    steps: ["obs_test_thanks"],
  });
  const s = assignmentOf(desk.db, id);
  if (!s) {
    throw new Error("no assignment");
  }
  const before = decisionsNow().length;
  for (const name of ["finish", "set_wait"]) {
    expect(turnRefusalOf(desk, name, "event", null, s)).toBeNull();
  }
  await finish(desk, s, "a thanks: nothing to do");
  expect(assignmentOf(desk.db, id)?.closed_at).not.toBeNull();
  expect(decisionsNow()).toHaveLength(before);
  setSystemTime();
});

test("the main session's question wakes its agent at once; its turn ends only once his words are read, and the reply comes back", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const s = on(desk, agent);
  const asked = askAssignment(desk, s.id, "Where are we with the plumber?");
  if ("error" in asked) {
    throw new Error(asked.error);
  }
  expect(turnRefusalOf(desk, "finish", "main_question", null, s)).toContain(
    "read it (`read_question`)"
  );
  expect(() => readQuestion(desk, { id: "asg_other" }, asked.id)).toThrow(
    "is no question to asg_other"
  );
  expect(readQuestion(desk, s, asked.id)).toEqual({
    words: "Where are we with the plumber?",
  });
  expect(turnRefusalOf(desk, "finish", "main_question", null, s)).toBeNull();
  answerQuestion(desk, s, asked.id, "Waiting on his quote, due Thursday.");
  expect(await asked.reply).toBe("Waiting on his quote, due Thursday.");
  expect(
    desk.db.query("select name from event where assignment_id = ?").all(s.id)
  ).toContainEqual({ name: "main_question" });
  setSystemTime();
});

// His phone showed a plan as a wall of text (22 Nov 2026): the plan written as a numbered list in `context`, its own
// options, no `plan`. Any card, from any asker, that writes steps as a numbered list is refused with how to resend it.
test("a plan written as a numbered list in `context` is refused on any card; quotes and code are not steps", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const card = (context: string) => ({
    context,
    deadline: ahead(DAY),
    onSilence: null,
    options: [
      { id: "go", label: "Go" },
      { id: "no", label: "Not now" },
    ],
    question: "Go ahead?",
    title: "Mend the watch",
  });
  const asText =
    "What I found:\n- Kit quoted 80 €.\n\nPlan, in order:\n1. Ask Kit for the quote.\n2. Pay the deposit.";
  const refused = await Promise.allSettled([
    askDecision(desk, on(desk, agent), { ...card(asText), ...FIELDS }),
    requestDecision(DESK_AGENT, { ...card(asText), agent }),
  ]);
  expect(
    refused.map((r) => r.status === "rejected" && String(r.reason))
  ).toEqual(
    refused.map(() =>
      expect.stringContaining(
        "a numbered list in `context` is a plan as text: give its steps as `plan`"
      )
    )
  );
  const quoted =
    "> 1. Bring the watch\n> 2. Pay at pickup\n*Kit*\n\n```\n1. a\n2. b\n```";
  await expect(
    requestDecision(DESK_AGENT, { ...card(quoted), agent })
  ).resolves.toMatchObject({ id: expect.any(String) });
  setSystemTime();
});

// Cards that added to his load (22 Nov 2026): a close card that said it had not checked, a card naming the Personal
// agent and refs, contexts longer than what he needs. Refused for any asker; someone else's quoted words never count.
test("a card that says it did not check, shows Life's inside or runs long is refused; quotes and link targets aside", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const card = (context: string, title = "Mend the watch") => ({
    context,
    deadline: ahead(DAY),
    onSilence: null,
    options: [
      { id: "close", label: "Close it" },
      { id: "keep", label: "Keep it open" },
    ],
    question: "Close the watch repair?",
    title,
  });
  const refusals = await Promise.allSettled([
    requestDecision(DESK_AGENT, {
      ...card("Not verified: whether Kit was paid."),
      agent,
    }),
    requestDecision(DESK_AGENT, {
      ...card("I didn't open the mail thread past 18 Nov."),
      agent,
    }),
    requestDecision(DESK_AGENT, {
      ...card("Kit fixed it.", "Personal agent: close the watch"),
      agent,
    }),
    requestDecision(DESK_AGENT, { ...card("See obs_5bdeee7a8a60."), agent }),
    requestDecision(DESK_AGENT, {
      ...card("Kit fixed it. ".repeat(100)),
      agent,
    }),
  ]);
  expect(
    refusals.map((r) => r.status === "rejected" && String(r.reason))
  ).toEqual([
    expect.stringContaining('"Not verified": check it with your tools'),
    expect.stringContaining('"I didn\'t open": check it with your tools'),
    expect.stringContaining('"Personal agent" is Life\'s inside'),
    expect.stringContaining('"obs_5bdeee7a8a60" is Life\'s inside'),
    expect.stringContaining("`context` holds 1400 characters"),
  ]);
  const quoted =
    "Kit fixed it ([his message](https://example.com/obs_5bdeee7a8a60)) and Anna didn't read it yet; the bank couldn't verify the first transfer.\n> Not verified yet, said the shop\n*Kit*";
  await expect(
    requestDecision(DESK_AGENT, { ...card(quoted), agent })
  ).resolves.toMatchObject({ id: expect.any(String) });
  setSystemTime();
});
