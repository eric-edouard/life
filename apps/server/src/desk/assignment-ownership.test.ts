import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY, iso, MIN } from "../core/clock";
import { agentsNow, agentsOnSteps } from "../host/agents-now";
import {
  agentOf,
  assignmentOf,
  assignmentOfCard,
  cardOwnersOf,
  openAssignments,
  readStartFacts,
} from "../host/desk-read";
import { cardHoldersOf } from "../host/inbox";
import { decisionsNow } from "../memory/decisions";
import {
  askDecision,
  openAssignment,
  register,
  withdrawOpenCards,
} from "./agent-actions";
import { start } from "./agent-changes";
import { readPeopleOnce, wakeDue } from "./desk-clock";
import { foldAssignments } from "./matter-net";
import { advance, setup, toDo, withBook } from "./test-desk";

// The debt verdict on PR 3 (#810, 21 Nov 2026): an agent and its assignments are not one thing. Each test is one of its
// findings, made up.

afterEach(() => {
  setSystemTime();
});

const later = () => new Date(clock().getTime() + 30 * DAY).toISOString();

/** An agent of the made-up desk, its own listening waiting a month. */
function standing(
  desk: ReturnType<typeof setup>["desk"],
  a: { project?: string; role?: "personal" }
) {
  const id = register(desk, { brief: "Test brief", runtime: "fake", ...a });
  desk.db.run("update assignment set wait_until = ? where agent_id = ?", [
    later(),
    id,
  ]);
  return id;
}

test("a start on matter A hands over only A of the stopped agent: its matter B keeps its wait, its own stays, it stays stopped", () => {
  const { desk } = setup();
  const personal = standing(desk, { role: "personal" });
  const a = openAssignment(desk, personal, {
    openedBy: "owner",
    steps: ["obs_test_a"],
  });
  const b = openAssignment(desk, personal, {
    openedBy: "owner",
    steps: ["obs_test_b"],
  });
  desk.db.run(
    "update assignment set wait_until = ?, wait_reason = 'Test: B waits' where id = ?",
    [later(), b]
  );
  desk.db.run("update agent set status = 'stopped' where id = ?", [personal]);
  const shop = standing(desk, { project: "test-shop" });
  expect(
    start(desk, { action: "start", steps: ["obs_test_a"] }, "Test: A", {
      taker: shop,
    })
  ).toEqual({ id: shop });
  expect(assignmentOf(desk.db, a)?.outcome).toBe(`replaced by ${shop}`);
  expect(assignmentOf(desk.db, b)).toMatchObject({
    closed_at: null,
    wait_reason: "Test: B waits",
  });
  expect(agentOf(desk.db, personal)?.status).toBe("stopped");
});

test("an agent's 51st open assignment is read and woken like its first", async () => {
  const { desk } = setup();
  const id = standing(desk, {});
  const opened = Array.from({ length: 51 }, (_, i) =>
    openAssignment(desk, id, { openedBy: "desk", steps: [`obs_test_${i}`] })
  );
  const last = opened.at(-1) ?? "";
  desk.db.run("update assignment set wait_until = ? where id <> ?", [
    later(),
    last,
  ]);
  expect(openAssignments(desk.db).map((s) => s.id)).toContain(last);
  await wakeDue(desk);
  expect(
    desk.db
      .query<{ assignment_id: string }, [string]>(
        "select assignment_id from turn where agent_id = ?"
      )
      .all(id)
  ).toEqual([{ assignment_id: last }]);
});

test("a card asked before the desk kept its owner stays its agent's first assignment's when another runs a turn", () => {
  const { desk } = setup();
  const id = standing(desk, {});
  const first = openAssignments(desk.db)[0]?.id ?? null;
  const card = { agent: id, id: "dec_test_before_owners" };
  expect(assignmentOfCard(desk.db, card)).toBe(first);
  const second = openAssignment(desk, id, {
    openedBy: "owner",
    steps: ["obs_test_c"],
  });
  desk.db.run(
    "insert into turn (agent_id, assignment_id, cause, started_at) values (?, ?, 'event', ?)",
    [id, second, clock().toISOString()]
  );
  expect(assignmentOfCard(desk.db, card)).toBe(first);
});

// Verdict on PR 841: the card's line is written before the desk's row of it commits; the desk stopping between them
// left the card to its agent's first assignment. The line names the assignment that asked it.
test("a card whose owner row never committed stays with the assignment that asked it, not its agent's first", async () => {
  const { desk } = setup();
  const id = standing(desk, {});
  const second = openAssignment(desk, id, { openedBy: "owner" });
  const s = assignmentOf(desk.db, second);
  if (!s) {
    throw new Error("no second assignment");
  }
  const asked = await askDecision(desk, s, {
    context: "A made-up reason to ask.",
    deadline: iso(clock().getTime() + DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: go on?",
    title: "a test",
  });
  desk.db.run("delete from card where decision_id = ?", [asked.id]);
  const card = decisionsNow().find((d) => d.id === asked.id);
  expect(card?.assignment).toBe(second);
  expect(assignmentOfCard(desk.db, card ?? { id: "" })).toBe(second);
  await withdrawOpenCards(desk.db, s, "test over");
});

test("a fold onto an agent leaves its own older card on its own assignment", async () => {
  const { desk } = setup();
  desk.embedder = null;
  const step = "obs_00000000f061";
  await withBook(
    [toDo(step, "I'll book the piano tuner")],
    { id: "matter_00000000f061", steps: [step] },
    async () => {
      // The matter's assignment is older than the Personal agent's own: after the move it is the agent's first.
      const old = register(desk, {
        brief: "Test brief: the piano",
        runtime: "fake",
        steps: [step],
      });
      advance(MIN);
      const personal = standing(desk, { role: "personal" });
      const own = openAssignments(desk.db).find((s) => s.agent_id === personal);
      if (!own) {
        throw new Error("no own assignment");
      }
      const { id } = await askDecision(desk, own, {
        context: "A made-up reason to ask.",
        deadline: iso(clock().getTime() + DAY),
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        question: "Test: go on?",
        title: "a test",
      });
      // Asked before the desk kept owners.
      desk.db.run("delete from card where decision_id = ?", [id]);
      const card = { agent: personal, id };
      expect(assignmentOfCard(desk.db, card)).toBe(own.id);
      await foldAssignments(desk, readPeopleOnce());
      expect(
        openAssignments(desk.db).filter((s) => s.agent_id === personal)
      ).toHaveLength(2);
      expect(agentOf(desk.db, old)?.status).toBe("ended");
      expect(assignmentOfCard(desk.db, card)).toBe(own.id);
      await withdrawOpenCards(desk.db, own, "test over");
    }
  );
});

test("a repeated Start reports the open assignment it found, never a newer closed one on another of its steps, even on the matter he chose", () => {
  const { desk } = setup();
  const id = standing(desk, {});
  const open = openAssignment(desk, id, {
    matter: "matter_00000000b001",
    openedBy: "owner",
    steps: ["obs_test_d1"],
  });
  advance(MIN);
  const closed = openAssignment(desk, id, {
    matter: "matter_00000000a001",
    openedBy: "owner",
    steps: ["obs_test_d2"],
  });
  desk.db.run(
    "update assignment set closed_at = ?, outcome = 'test' where id = ?",
    [clock().toISOString(), closed]
  );
  desk.db.run(
    "insert into agent_change (ask, agent_id, applied_at) values ('entry_test', ?, ?)",
    [id, clock().toISOString()]
  );
  for (const matter of [undefined, "matter_00000000a001"]) {
    expect(
      readStartFacts(desk.db, "entry_test", {
        matter,
        steps: ["obs_test_d1", "obs_test_d2"],
      }).assignment?.id
    ).toBe(open);
  }
});

test("a fold shows its card as asked by the new holder, and the agent it emptied is still read", async () => {
  const { desk } = setup();
  desk.embedder = null;
  const step = "obs_00000000f062";
  await withBook(
    [toDo(step, "I'll call the roofer")],
    { id: "matter_00000000f062", steps: [step] },
    async () => {
      const old = register(desk, {
        brief: "Test brief: the roof",
        runtime: "fake",
        steps: [step],
      });
      const personal = standing(desk, { role: "personal" });
      const onMatter = openAssignments(desk.db).find((s) => s.agent_id === old);
      if (!onMatter) {
        throw new Error("no matter assignment");
      }
      const { id } = await askDecision(desk, onMatter, {
        context: "A made-up reason to ask.",
        deadline: iso(clock().getTime() + DAY),
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        question: "Test: call them?",
        title: "a test",
      });
      await foldAssignments(desk, readPeopleOnce());
      expect(cardOwnersOf(desk.db, [{ agent: old, id }])[id]).toEqual({
        assignment: onMatter.id,
        holder: personal,
      });
      expect(
        agentsNow(desk.db, clock().getTime()).find((a) => a.id === old)
      ).toMatchObject({ status: "ended", steps: [] });
      await withdrawOpenCards(desk.db, { agent_id: personal }, "test over");
    }
  );
});

test("each open card is its own assignment's, so an agent holding two shows each one's on it", async () => {
  const { desk } = setup();
  const step = "obs_00000000f063";
  await withBook(
    [toDo(step, "I'll paint the fence")],
    { id: "matter_00000000f063", steps: [step] },
    async () => {
      const id = standing(desk, {});
      const own = openAssignments(desk.db).find((s) => s.agent_id === id);
      const other = assignmentOf(
        desk.db,
        openAssignment(desk, id, { openedBy: "owner", steps: [step] })
      );
      if (!(own && other)) {
        throw new Error("no assignments");
      }
      const ask = (s: typeof own) =>
        askDecision(desk, s, {
          context: "A made-up reason to ask.",
          deadline: iso(clock().getTime() + DAY),
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          question: "Test: go on?",
          title: "a test",
        });
      const a = await ask(own);
      const b = await ask(other);
      const owners = cardOwnersOf(desk.db, [
        { agent: id, id: a.id },
        { agent: id, id: b.id },
      ]);
      expect([owners[a.id]?.assignment, owners[b.id]?.assignment]).toEqual([
        own.id,
        other.id,
      ]);
      // The matter's read shows the agent by its assignment on that matter, so its card is B's, never its own A's.
      const [onIt] = agentsOnSteps(desk.db, [step], clock().getTime(), true);
      expect(onIt?.assignment).toBe(other.id);
      expect(owners[b.id]?.assignment).toBe(other.id);
      await withdrawOpenCards(desk.db, { agent_id: id }, "test over");
    }
  );
});

test("a folded card opens its holder's session now, or none: never a session it was asked from", () => {
  const { desk } = setup();
  const asker = standing(desk, {});
  const holder = standing(desk, { project: "test-shop" });
  const held = openAssignment(desk, holder, {
    openedBy: "owner",
    steps: ["obs_test_fold"],
  });
  desk.db.run("insert into card (decision_id, assignment_id) values (?, ?)", [
    "dec_test_fold",
    held,
  ]);
  // The asker's session was replaced since it asked (its old link stays on its cards).
  desk.db.run("update agent set link = 'fake://asker-new' where id = ?", [
    asker,
  ]);
  const cards = [
    { agent: asker, id: "dec_test_fold" },
    { agent: asker, id: "dec_test_own" },
  ];
  const shown = () => Object.fromEntries(cardHoldersOf(desk.db, cards));
  // The holder has no session yet: none, never the asker's.
  expect(shown()).toEqual({
    dec_test_fold: { agent: holder },
    dec_test_own: { agent: asker, session: "fake://asker-new" },
  });
  desk.db.run("update agent set link = 'fake://holder' where id = ?", [holder]);
  expect(shown().dec_test_fold).toEqual({
    agent: holder,
    session: "fake://holder",
  });
});

/** A made-up card on `subject`, asked from assignment `s`'s turn. */
const askOn = (
  desk: ReturnType<typeof setup>["desk"],
  s: Parameters<typeof askDecision>[1],
  subject: string
) =>
  askDecision(desk, s, {
    context: "A made-up reason to ask.",
    deadline: iso(clock().getTime() + DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: go on?",
    subject,
    title: "a test",
  });

test("a card goes on any matter its agent holds, filed under the assignment holding it; another is refused", async () => {
  const { desk } = setup();
  const [a, b, c, d] = ["a", "b", "c", "d"].map(
    (x) => `obs_00000000f0${x}${x}`
  ) as [string, string, string, string];
  await withBook(
    [
      toDo(a, "I'll tune the piano"),
      toDo(b, "I'll pay the plumber"),
      toDo(c, "I'll renew the insurance"),
      toDo(d, "I'll water the plants"),
    ],
    { id: "matter_00000000f0aa", steps: [a] },
    async () => {
      const personal = standing(desk, { role: "personal" });
      const own = openAssignments(desk.db).find((s) => s.agent_id === personal);
      const onA = assignmentOf(
        desk.db,
        openAssignment(desk, personal, { openedBy: "owner", steps: [a] })
      );
      const onB = openAssignment(desk, personal, {
        openedBy: "desk",
        steps: [b],
      });
      const other = standing(desk, {});
      const onD = assignmentOf(
        desk.db,
        openAssignment(desk, other, { openedBy: "owner", steps: [d] })
      );
      if (!(own && onA && onD)) {
        throw new Error("no assignments");
      }
      const ownerOf = (id: string) =>
        cardOwnersOf(desk.db, [{ agent: personal, id }])[id]?.assignment;
      // Woken on A, asks on B's matter: filed under B.
      expect(ownerOf((await askOn(desk, onA, b)).id)).toBe(onB);
      // A matter under no project, which the Personal agent takes: filed under its own assignment.
      expect(ownerOf((await askOn(desk, onA, c)).id)).toBe(own.id);
      // Another agent, on a matter it neither is assigned nor takes (the Personal agent takes it): refused.
      await expect(askOn(desk, onD, c)).rejects.toThrow(
        "is not on a matter you hold"
      );
      // Nor from its own assignment.
      const otherOwn = openAssignments(desk.db).find(
        (s) => s.agent_id === other && s.id !== onD.id
      );
      if (!otherOwn) {
        throw new Error("no own assignment");
      }
      await expect(askOn(desk, otherOwn, c)).rejects.toThrow(
        "is not on a matter you hold"
      );
      await withdrawOpenCards(desk.db, { agent_id: personal }, "test over");
    }
  );
});
