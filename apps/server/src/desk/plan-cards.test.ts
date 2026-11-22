import { expect, setSystemTime, test } from "bun:test";
import { DAY } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { assignmentOf } from "../host/desk-read";
import { opensWithPlan } from "../host/inbox";
import { decisionCardOf } from "../memory/checks";
import {
  answerDecision,
  decisionsNow,
  requestDecision,
} from "../memory/decisions";
import {
  askDecision,
  hasAsked,
  openAssignment,
  readPacket,
  register,
} from "./agent-actions";
import { ahead, matterView, on, setup, withMatters } from "./test-desk";

// Which assignment must open with a plan card (life#816): one he opened; never the caretaker's, nor a hand-out's.
test("an assignment he opened opens with a plan card; a hand-out's and the caretaker's do not", () => {
  const { desk } = setup();
  const shop = register(desk, { brief: "Test brief", runtime: "fake" });
  const asked = openAssignment(desk, shop, {
    openedBy: "owner",
    steps: ["obs_test_asked"],
  });
  const found = openAssignment(desk, shop, {
    openedBy: "desk",
    steps: ["obs_test_found"],
  });
  const caretaker = register(desk, {
    brief: "Test brief",
    role: "caretaker",
    runtime: "fake",
  });
  const opens = (id: string) => {
    const s = assignmentOf(desk.db, id);
    return s ? opensWithPlan(desk.db, s) : null;
  };
  expect([asked, found, on(desk, caretaker).id].map(opens)).toEqual([
    true,
    false,
    false,
  ]);
  setSystemTime();
});

// Regression (the plan card's wire): its steps and what they were gathered from round-trip from the door to his card,
// its two options as his app's roles; a plan card needs `start` then `decline`, in the agent's words; a later card may present a new plan.
test("a plan card's `plan` and `gathered` reach his card, and a later card presents a plan the same way", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const s = on(desk, agent);
  const plan = [
    {
      by: "agent",
      channel: "whatsapp",
      text: "Ask Kit for the quote",
      when: "today",
    },
    { by: "owner", channel: "payment", text: "Pay the deposit" },
    { by: "agent", text: "Book the repair", when: "once Kit answers, by Thu" },
  ];
  const card = (over: Record<string, unknown> = {}) => ({
    context: "What I read:\n- Kit's quote, 80 €",
    deadline: ahead(DAY),
    gathered: { text: "From Kit's quote and two others" },
    onSilence: null,
    options: [
      { id: "start", label: "Start the plan" },
      { id: "decline", label: "Not this plan" },
    ],
    plan,
    question: "Start with this plan?",
    title: "Mend the watch",
    ...over,
  });
  const wrongOptions = [
    [
      { id: "go", label: "Go" },
      { id: "decline", label: "Not this plan" },
    ],
    [
      { id: "start", label: "Start the plan" },
      { id: "stop", label: "Stop" },
    ],
    // The decline first: his main button would decline it.
    [
      { id: "decline", label: "Not this plan" },
      { id: "start", label: "Start the plan" },
    ],
  ];
  const refusals = await Promise.allSettled(
    wrongOptions.map((options) => askDecision(desk, s, card({ options })))
  );
  expect(
    refusals.map((r) => r.status === "rejected" && String(r.reason))
  ).toEqual(
    wrongOptions.map(() =>
      expect.stringContaining(
        "a plan card's options are ids start then decline"
      )
    )
  );
  await expect(
    askDecision(desk, s, card({ onSilence: "start" }))
  ).rejects.toThrow("on silence no plan starts");
  const { id } = await askDecision(desk, s, card());
  const d = decisionsNow().find((x) => x.id === id);
  expect(d && decisionCardOf(d)).toMatchObject({
    gathered: { text: "From Kit's quote and two others" },
    options: [
      { id: "start", role: "start" },
      { id: "decline", role: "decline" },
    ],
    plan,
  });
  // One pick: both would tell the agent to start and not to.
  await expect(answerDecision(id, ["start", "decline"])).rejects.toThrow(
    "a plan card takes one pick"
  );
  await answerDecision(id, ["start"]);
  // A changed plan after his answer is a new plan card, its steps in `plan` too.
  const later = await askDecision(desk, s, card());
  expect(
    decisionsNow()
      .find((x) => x.id === later.id)
      ?.plan?.map((p) => p.text)
  ).toEqual(plan.map((p) => p.text));
  setSystemTime();
});

// His phone drew an empty card for a plan asked in `context` alone (21 Nov 2026): the plan card must give its steps.
test("a plan card without `plan` is refused, its steps asked for", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  await expect(
    askDecision(desk, on(desk, agent), {
      context: "What I read: Kit's quote.",
      deadline: ahead(DAY),
      onSilence: null,
      options: [
        { id: "start", label: "Go" },
        { id: "stop", label: "Not now" },
      ],
      question: "Start with this plan?",
      title: "Mend the watch",
    })
  ).rejects.toThrow("first card is its plan card: give its steps as `plan`");
  setSystemTime();
});

// His card read as a riddle (22 Nov 2026): an agent found its matter over and had to dress "close it" as a plan, with
// no option that closes anything, and asked before checking the thread. A first card that says it looks over is no
// plan: its done option marked `ends`; and the brief says to check what the tools can read before any card.
test("a first card that says the matter looks over needs no plan, and the brief says to check before asking", async () => {
  const { desk } = setup();
  const agent = register(desk, {
    brief: "Test brief",
    runtime: "fake",
    steps: ["obs_test_over"],
  });
  const s = on(desk, agent);
  const { id } = await withMatters(
    [matterView("mat_test_over", ["obs_test_over"])],
    () =>
      askDecision(desk, s, {
        context: "- Kit wrote on 20 Nov that the watch is mended.",
        deadline: ahead(DAY),
        onSilence: null,
        options: [
          { ends: "matter", id: "done", label: "Close it" },
          { id: "open", label: "Keep it open" },
        ],
        question: "Close the watch repair?",
        subject: "mat_test_over",
        title: "Mend the watch",
      })
  );
  expect(decisionsNow().find((d) => d.id === id)?.plan).toBeUndefined();
  const packet = await readPacket(desk, s, false);
  expect(packet).toContain("unless that card says the matter looks over");
  expect(packet).toContain("`request_decision`'s self-check");
  // Only that card: a first card that sends, or offers only a drop, is still its plan card.
  const other = register(desk, {
    brief: "Test brief",
    runtime: "fake",
    steps: ["obs_test_other"],
  });
  await expect(
    withMatters([matterView("mat_test_other", ["obs_test_other"])], () =>
      askDecision(desk, on(desk, other), {
        context: "- Kit asked for a date.",
        deadline: ahead(DAY),
        onSilence: null,
        options: [
          { id: "go", label: "Ask Kit" },
          { ends: "matter", icon: "drop", id: "drop", label: "Drop it" },
        ],
        question: "Ask Kit for a date?",
        subject: "mat_test_other",
        title: "Mend the watch",
      })
    )
  ).rejects.toThrow("first card is its plan card");
  setSystemTime();
});

// The pi trial (22 Nov 2026): an agent asked a throwaway plan card and withdrew it. A card its own agent withdrew is not
// its plan card: the assignment has asked nothing, so its next card must be the plan again.
test("a plan card its agent withdrew does not count as asked: the next card is the plan card again", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const s = on(desk, agent);
  const card = (over: Record<string, unknown> = {}) => ({
    context: "What I read:\n- Kit's quote, 80 €",
    deadline: ahead(DAY),
    onSilence: null,
    options: [
      { id: "start", label: "Start the plan" },
      { id: "decline", label: "Not this plan" },
    ],
    plan: [{ by: "agent", text: "Ask Kit for the quote" }],
    question: "Start with this plan?",
    title: "Mend the watch",
    ...over,
  });
  const { id } = await askDecision(desk, s, card());
  expect(hasAsked(desk.db, s)).toBe(true);
  await askDecision(desk, s, { why: "a probe", withdraw: id });
  expect(hasAsked(desk.db, s)).toBe(false);
  await expect(
    askDecision(
      desk,
      s,
      card({
        options: [
          { id: "go", label: "Go" },
          { id: "no", label: "Not now" },
        ],
        plan: undefined,
        question: "Go ahead?",
      })
    )
  ).rejects.toThrow("first card is its plan card");
  setSystemTime();
});

// life#1114: plan cards asked before `plan` was required (21 Nov 2026) are still in his store: they read as plan cards,
// their plan in `context`, `plan` null.
test("a plan card stored before `plan` was required still reads as his plan card", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const s = on(desk, agent);
  // Written as the store holds it, past the door's rule.
  const { id } = await requestDecision(DESK_AGENT, {
    agent,
    context: "## Plan\n1. Ask Kit",
    deadline: ahead(DAY),
    onSilence: null,
    options: [
      { id: "start", label: "Go" },
      { id: "stop", label: "Not now" },
    ],
    question: "Start with this plan?",
    title: "Mend the watch",
  });
  desk.db.run("insert into card (decision_id, assignment_id) values (?, ?)", [
    id,
    s.id,
  ]);
  const d = decisionsNow().find((x) => x.id === id);
  expect(d && decisionCardOf(d)).toMatchObject({
    gathered: null,
    options: [
      { id: "start", takes: null },
      { id: "stop", takes: null },
    ],
    plan: null,
  });
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
    askDecision(desk, on(desk, agent), card(asText)),
    requestDecision(DESK_AGENT, { ...card(asText), agent }),
  ]);
  expect(
    refused.map((r) => r.status === "rejected" && String(r.reason))
  ).toEqual(
    refused.map(() =>
      expect.stringContaining(
        "a numbered list in `context` is a plan as text: give its steps as `plan`, with options `start` then `decline`"
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
    expect.stringContaining('"didn\'t open": check it with your tools'),
    expect.stringContaining('"Personal agent" is Life\'s inside'),
    expect.stringContaining('"obs_5bdeee7a8a60" is Life\'s inside'),
    expect.stringContaining("`context` holds 1400 characters"),
  ]);
  const quoted =
    "Kit fixed it ([his message](https://example.com/obs_5bdeee7a8a60)).\n> Not verified yet, said the shop\n*Kit*";
  await expect(
    requestDecision(DESK_AGENT, { ...card(quoted), agent })
  ).resolves.toMatchObject({ id: expect.any(String) });
  setSystemTime();
});
