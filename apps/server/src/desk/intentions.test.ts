import { afterEach, expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { INSTRUCTIONS, recordInstruction } from "../memory/instructions";
import { register } from "./agent-actions";
import { openIntentions } from "./hand-out-tick";
import { setup } from "./test-desk";

// His standing intentions open their assignment (`openIntentions`), over a fake runtime and made-up people.

afterEach(() => {
  rmSync(INSTRUCTIONS, { force: true });
  setSystemTime();
});

test("his standing intention opens one assignment of the Personal agent, anchored on it, once; it closes when the intention is replaced", async () => {
  const t = setup();
  t.desk.runtimes = { claude: t.fake.runtime };
  const personal = register(t.desk, {
    brief: "Test: the Personal agent",
    folder: t.dir,
    role: "personal",
    runtime: "claude",
  });
  const said = "remind me to call Test Ana on her birthday";
  const i = recordInstruction({
    effect: "intention",
    said,
    scope: "person:test-ana",
    text: "Call Test Ana on her birthday",
  });
  const intentions = () =>
    t.desk.db
      .query<
        {
          agent_id: string;
          closed_at: string | null;
          opened_by: string;
          said: string;
        },
        [string]
      >(
        "select s.agent_id, s.closed_at, s.opened_by, s.said from assignment s join anchor n on n.assignment_id = s.id where n.step = ?"
      )
      .all(i.id);
  await openIntentions(t.desk);
  await openIntentions(t.desk);
  expect(intentions()).toEqual([
    { agent_id: personal, closed_at: null, opened_by: "owner", said },
  ]);
  recordInstruction({
    replaces: i.id,
    said,
    scope: "person:test-ana",
    text: "Nothing more about Test Ana's birthday",
  });
  await openIntentions(t.desk);
  expect(intentions()[0]?.closed_at).not.toBeNull();
  await openIntentions(t.desk);
  expect(intentions()).toHaveLength(1);
});
