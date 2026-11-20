import { expect, setSystemTime, test } from "bun:test";
import { planCardsOf } from "../host/inbox";
import type { Decision } from "../memory/decisions";
import { openAssignment, register } from "./agent-actions";
import { setup } from "./test-desk";

// The plan card (life#816): an assignment he opened, its first card not withdrawn, worked out when read; never the
// caretaker's, nor a hand-out's one card.

test("an open card is a plan when it is the first card not withdrawn of an assignment he opened", () => {
  const { desk } = setup();
  const shop = register(desk, { brief: "Test brief", runtime: "fake" });
  const ownOf = (agent: string) =>
    desk.db
      .query<{ id: string }, [string]>(
        "select id from assignment where agent_id = ?"
      )
      .get(agent)?.id ?? "";
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
  const cards: [string, string, string, Decision["state"]][] = [
    ["dec_test_withdrawn", shop, ownOf(shop), "withdrawn"],
    ["dec_test_plan", shop, ownOf(shop), "open"],
    ["dec_test_answered", shop, asked, "answered"],
    ["dec_test_later", shop, asked, "open"],
    ["dec_test_found", shop, found, "open"],
    ["dec_test_change", caretaker, ownOf(caretaker), "open"],
  ];
  for (const [id, , assignment] of cards) {
    desk.db.run("insert into card (decision_id, assignment_id) values (?, ?)", [
      id,
      assignment,
    ]);
  }
  const list = cards.map(
    ([id, agent, , state]) => ({ agent, id, state }) as Decision
  );
  expect([...planCardsOf(desk.db, list)]).toEqual(["dec_test_plan"]);
  setSystemTime();
});
