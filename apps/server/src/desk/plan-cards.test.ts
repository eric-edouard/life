import { expect, setSystemTime, test } from "bun:test";
import { planCardsOf } from "../host/inbox";
import type { Decision } from "../memory/decisions";
import { openAssignment, register } from "./agent-actions";
import { setup } from "./test-desk";

// The plan card (life#816): each assignment's first card not withdrawn, worked out when read; never the caretaker's.

test("an assignment's first card not withdrawn is its plan; its later cards, another assignment's first and the caretaker's are not", () => {
  const { desk } = setup();
  const shop = register(desk, { brief: "Test brief", runtime: "fake" });
  const [own] = desk.db
    .query<{ id: string }, [string]>(
      "select id from assignment where agent_id = ?"
    )
    .all(shop);
  const matter = openAssignment(desk, shop, {
    openedBy: "desk",
    steps: ["obs_test_plan"],
  });
  const caretaker = register(desk, {
    brief: "Test brief",
    role: "caretaker",
    runtime: "fake",
  });
  const cards: [string, string, string, Decision["state"]][] = [
    ["dec_test_withdrawn", shop, own?.id ?? "", "withdrawn"],
    ["dec_test_plan", shop, own?.id ?? "", "answered"],
    ["dec_test_later", shop, own?.id ?? "", "open"],
    ["dec_test_found", shop, matter, "open"],
    ["dec_test_change", caretaker, "", "open"],
  ];
  for (const [id, , assignment] of cards.filter(([, , s]) => s)) {
    desk.db.run("insert into card (decision_id, assignment_id) values (?, ?)", [
      id,
      assignment,
    ]);
  }
  const list = cards.map(
    ([id, agent, , state]) => ({ agent, id, state }) as Decision
  );
  expect([...planCardsOf(desk.db, list)].sort()).toEqual([
    "dec_test_found",
    "dec_test_plan",
  ]);
  setSystemTime();
});
