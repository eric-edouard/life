import { expect, setSystemTime, test } from "bun:test";
import { DAY } from "../core/clock";
import { planCardsOf } from "../host/inbox";
import { decisionCardOf } from "../memory/checks";
import type { Decision } from "../memory/decision-lines";
import { answerDecision, decisionsNow } from "../memory/decisions";
import { askDecision, openAssignment, register } from "./agent-actions";
import { ahead, on, setup } from "./test-desk";

// The plan card (life#816): an assignment he opened, its first card not withdrawn, worked out when read; never the
// caretaker's, nor a hand-out's one card.

test("an open card is a plan when it is the first card not withdrawn of an assignment he opened", () => {
  const { desk } = setup();
  const shop = register(desk, { brief: "Test brief", runtime: "fake" });
  const own = on(desk, shop).id;
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
  const changes = on(desk, caretaker).id;
  const replaced = openAssignment(desk, shop, {
    openedBy: "owner",
    steps: ["obs_test_replaced"],
  });
  const cards: [string, string, string, Decision["state"]][] = [
    ["dec_test_replaced", shop, replaced, "withdrawn"],
    ["dec_test_follow_up", shop, replaced, "open"],
    ["dec_test_withdrawn", shop, own, "withdrawn"],
    ["dec_test_plan", shop, own, "open"],
    ["dec_test_answered", shop, asked, "answered"],
    ["dec_test_later", shop, asked, "open"],
    ["dec_test_found", shop, found, "open"],
    ["dec_test_change", caretaker, changes, "open"],
  ];
  for (const [id, , assignment] of cards) {
    desk.db.run("insert into card (decision_id, assignment_id) values (?, ?)", [
      id,
      assignment,
    ]);
  }
  const list = cards.map(
    ([id, agent, , state]) =>
      ({
        agent,
        id,
        state,
        ...(id === "dec_test_replaced"
          ? { withdrawn: { replacedBy: "dec_test_other" } }
          : {}),
      }) as Decision
  );
  expect([...planCardsOf(desk.db, list)]).toEqual(["dec_test_plan"]);
  setSystemTime();
});

// Regression (the plan card's wire): its steps and what they were gathered from round-trip from the door to his card,
// its two options as his app's roles; a plan card needs `start` and `decline`, and no later card takes a plan.
test("a plan card's `plan` and `gathered` reach his card, and only the plan card takes them", async () => {
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
    context: "What I read: Kit's quote.",
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
    // Swapped labels: his tap on "Not this plan" would start it.
    [
      { id: "start", label: "Not this plan" },
      { id: "decline", label: "Start the plan" },
    ],
  ];
  const refusals = await Promise.allSettled(
    wrongOptions.map((options) => askDecision(desk, s, card({ options })))
  );
  expect(
    refusals.map((r) => r.status === "rejected" && String(r.reason))
  ).toEqual(
    wrongOptions.map(() =>
      expect.stringContaining("a plan card's options are exactly")
    )
  );
  await expect(
    askDecision(desk, s, card({ onSilence: "start" }))
  ).rejects.toThrow("on silence no plan starts");
  const { id } = await askDecision(desk, s, card());
  const d = decisionsNow().find((x) => x.id === id);
  expect(d && [...planCardsOf(desk.db, [d])]).toEqual([id]);
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
  // The plan card is asked: a later card is no plan, and refuses one.
  await expect(askDecision(desk, s, card())).rejects.toThrow(
    "only on an assignment's plan card"
  );
  setSystemTime();
});

// Old plan cards, asked before `plan`: their plan is in `context`, and they read as ever, no role on their options.
test("a plan card without `plan` still reads", async () => {
  const { desk } = setup();
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const { id } = await askDecision(desk, on(desk, agent), {
    context: "## Plan\n1. Ask Kit",
    deadline: ahead(DAY),
    onSilence: null,
    options: [
      { id: "start", label: "Go" },
      { id: "stop", label: "Stop the agent" },
    ],
    question: "Start with this plan?",
    title: "Mend the watch",
  });
  const d = decisionsNow().find((x) => x.id === id);
  expect(d && [...planCardsOf(desk.db, [d])]).toEqual([id]);
  expect(d && decisionCardOf(d)).toMatchObject({
    gathered: null,
    options: [
      { id: "start", takes: null },
      { id: "stop", takes: null },
    ],
    plan: null,
  });
  expect(d && decisionCardOf(d).options[0]).not.toHaveProperty("role");
  setSystemTime();
});
