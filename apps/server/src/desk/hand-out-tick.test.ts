import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { rmSync } from "node:fs";
import { clock, DAY, HOUR, iso, MIN } from "../core/clock";
import { setSettings, settings } from "../core/settings";
import { answerWithResult } from "../host/answer-result";
import { agentOf, assignmentOf, readNotes } from "../host/desk-read";
import { DECISION_ANSWERED } from "../host/events";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as checks from "../memory/checks";
import { DECISIONS, decisionsNow } from "../memory/decisions";
import { readCorrections, recordCorrection } from "../memory/memory-files";
import { handOutGateOf, readHandOutMatters } from "../memory/read-matters";
import { dayNow, dayStart, zoneNow } from "../memory/zones";
import {
  askDecision,
  finish,
  openAssignment,
  readPacket,
  register,
  withdrawOpenCards,
  writeNotes,
} from "./agent-actions";
import { pollAnswers, readPeopleOnce, wakeDue } from "./desk-clock";
import { writeWait } from "./desk-store";
import { NO_CARD_OUTCOME } from "./hand-out";
import { endAgentsWithoutCard, handOutNext } from "./hand-out-tick";
import {
  endAgentsOnOverMatters,
  foldAssignments,
  MATTER_DONE_OUTCOME,
} from "./matter-net";
import {
  asgOf,
  matterView,
  on,
  setup,
  toDo,
  withBook,
  withMatters,
} from "./test-desk";

// The hand-out's step of the tick, over a fake runtime and a made-up book of matters.

const was = settings().desk;
/** The decisions his inbox hides (a card on a matter that closed): every other open one is shown. */
let hidden = new Set<string>();
let inbox: ReturnType<typeof spyOn>;
beforeEach(() => {
  setSettings({
    desk: {
      defaultRuntime: "claude",
      handOut: { aDay: 2, cardsWaiting: 1000 },
      runtimes: {},
    },
  });
  hidden = new Set();
  // His inbox, made up: the open decisions it shows, as the desk asked them.
  inbox = spyOn(checks, "checksNow").mockImplementation(async () =>
    decisionsNow()
      .filter((d) => d.state === "open" && !hidden.has(d.id))
      .map(
        (d) =>
          ({
            about: [],
            asker: d.asker,
            deadline: d.deadline,
            group: "decision",
            kind: "decision",
            matter: null,
            pushId: "",
            ref: d.id,
          }) as never
      )
  );
});
afterEach(() => {
  inbox.mockRestore();
  setSettings({ desk: was ?? null });
  setSystemTime();
  rmSync(DECISIONS, { force: true });
});

const AT = "2026-11-18T09:00:00.000Z";
const matterOf = (id: string, at = AT) => ({
  id,
  nextStep: { kind: "do" as const, text: "Do it" } as never,
  projects: [],
  steps: [{ at, ref: `obs_${id.slice(4)}1` }],
});
/** The gates' facts when every matter passes them. */
const OPEN = {
  decisions: [],
  dismissed: new Set<string>(),
  isDue: () => false,
  isHis: () => true,
  isParked: () => false,
};
let MATTERS = [matterOf("mat_a"), matterOf("mat_b")];
const book = () => {
  const reads = { n: 0 };
  return {
    read: () => {
      reads.n += 1;
      return Promise.resolve({ facts: OPEN, matters: MATTERS });
    },
    reads,
  };
};
/** The Personal agent of the last desk made (`deskOf`): it takes every made-up matter (none has a project). */
let personal = "";
/** A test desk with the Personal agent, its own listening waiting a month, so only matters wake it. */
const deskOf = (t = setup()) => {
  t.desk.runtimes = { claude: t.fake.runtime };
  personal = register(t.desk, {
    brief: "Test: the Personal agent",
    folder: t.dir,
    isPersonal: true,
    runtime: "claude",
  });
  t.desk.db.run("update assignment set wait_until = ? where agent_id = ?", [
    iso(clock().getTime() + 30 * DAY),
    personal,
  ]);
  return t.desk;
};
/** The assignments the desk opened itself (the hand-out), oldest first. */
const handedOf = (desk: ReturnType<typeof deskOf>) =>
  desk.db
    .query<{ agent_id: string; id: string }, []>(
      "select id, agent_id from assignment where opened_by = 'desk' order by rowid"
    )
    .all();
/** Assignment `id`'s row: what the door's tools take. */
const byId = (desk: ReturnType<typeof deskOf>, id: string) => {
  const s = assignmentOf(desk.db, id);
  if (!s) {
    throw new Error(`no assignment ${id}`);
  }
  return s;
};
const countOf = (desk: ReturnType<typeof deskOf>, table: string) =>
  desk.db.query<{ n: number }, []>(`select count(*) as n from ${table}`).get()
    ?.n;

test("the top matter goes to the agent that takes it, as an assignment the desk opened, and none again within 10 minutes", async () => {
  const desk = deskOf();
  const { read, reads } = book();
  const id = await handOutNext(desk, read);
  expect(id).toBeTruthy();
  expect(handedOf(desk)).toEqual([{ agent_id: personal, id: id ?? "" }]);
  const anchored = desk.db
    .query<{ step: string }, [string]>(
      "select step from anchor where assignment_id = ?"
    )
    .all(id ?? "");
  expect(anchored).toEqual([{ step: "obs_a1" }]);
  setSystemTime(new Date(clock().getTime() + 9 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(1);
  setSystemTime(new Date(clock().getTime() + 2 * MIN));
  // The first matter is held now: the next look takes the second.
  const second = await handOutNext(desk, read);
  expect(second).toBeTruthy();
  expect(handedOf(desk)).toHaveLength(2);
});

// Regression (the agents and matters plan, PR 3): the hand-out only assigns.
test("ten hand-outs make no agent row and no session", async () => {
  setSettings({
    desk: {
      defaultRuntime: "claude",
      handOut: { aDay: 10, cardsWaiting: 1000 },
      runtimes: {},
    },
  });
  const desk = deskOf();
  const agents = countOf(desk, "agent");
  MATTERS = Array.from({ length: 10 }, (_, i) => matterOf(`mat_${i}`));
  try {
    for (let i = 0; i < 10; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one look at a time
      expect(await handOutNext(desk, book().read)).toBeTruthy();
      setSystemTime(new Date(clock().getTime() + 11 * MIN));
    }
  } finally {
    MATTERS = [matterOf("mat_a"), matterOf("mat_b")];
  }
  expect(handedOf(desk)).toHaveLength(10);
  expect(countOf(desk, "agent")).toBe(agents);
  expect(countOf(desk, "session")).toBe(0);
});

test("with no setting the hand-out is off and reads nothing", async () => {
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
  const desk = deskOf();
  const { read, reads } = book();
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(0);
  expect(handedOf(desk)).toHaveLength(0);
});

test("a look under the daily cap reads no matter book", async () => {
  const desk = deskOf();
  const { read, reads } = book();
  await handOutNext(desk, read);
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  await handOutNext(desk, read);
  expect(handedOf(desk)).toHaveLength(2);
  const before = reads.n;
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(before);
});

test("with no agent that takes matters nothing is handed out, no book is read, and the look still counts", async () => {
  const desk = deskOf();
  desk.db.run("update agent set status = 'stopped' where id = ?", [personal]);
  const { read, reads } = book();
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(0);
  desk.db.run("update agent set status = 'active' where id = ?", [personal]);
  setSystemTime(new Date(clock().getTime() + 9 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  setSystemTime(new Date(clock().getTime() + 2 * MIN));
  expect(await handOutNext(desk, read)).toBeTruthy();
});

test("the daily count follows his day: a hand-out before his day began is not counted", async () => {
  setSettings({
    desk: {
      defaultRuntime: "claude",
      handOut: { aDay: 1, cardsWaiting: 1000 },
      runtimes: {},
    },
  });
  const desk = deskOf();
  const { read, reads } = book();
  const old = register(desk, { brief: "Test brief", runtime: "claude" });
  const since = dayStart(dayNow(), zoneNow());
  const markAt = (id: string, at: number) =>
    desk.db.run(
      "update assignment set opened_by = 'desk', opened_at = ? where agent_id = ?",
      [new Date(at).toISOString(), id]
    );
  markAt(old, since.getTime() - MIN);
  expect(await handOutNext(desk, read)).toBeTruthy();
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(1);
});

/** A card of assignment `id` on its matter (the book holds the hand-out's made-up matters). */
/** The made-up matters as the book holds them. */
const views = () =>
  MATTERS.map((m) =>
    matterView(
      m.id,
      m.steps.map((x) => x.ref)
    )
  );
const ask = (desk: ReturnType<typeof deskOf>, id: string) =>
  withMatters(
    views(),
    () =>
      askDecision(desk, byId(desk, id), {
        deadline: iso(clock().getTime() + DAY),
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        question: "Test: send this?",
        title: "a test",
      })
  );
const paced = (cardsWaiting: number) =>
  setSettings({
    desk: {
      defaultRuntime: "claude",
      handOut: { aDay: 5, cardsWaiting },
      runtimes: {},
    },
  });

test("a look under the cards cap reads no matter book", async () => {
  const desk = deskOf();
  const { read, reads } = book();
  paced(1);
  const id = await handOutNext(desk, read);
  await ask(desk, id ?? "");
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(1);
});

// Finding 1 of the action pipeline review (20 Nov 2026): a card his inbox hides (its matter closed) still counted
// against the pace, so two of them stopped every hand-out with nothing he could see.
test("cards his inbox hides do not count against the pace: only the ones he is shown do", async () => {
  const desk = deskOf();
  paced(2);
  MATTERS = ["mat_a", "mat_b", "mat_c", "mat_d"].map((id) => matterOf(id));
  try {
    const a = (await handOutNext(desk, book().read)) ?? "";
    setSystemTime(new Date(clock().getTime() + 11 * MIN));
    const b = (await handOutNext(desk, book().read)) ?? "";
    hidden = new Set([(await ask(desk, a)).id, (await ask(desk, b)).id]);
    setSystemTime(new Date(clock().getTime() + 11 * MIN));
    const c = (await handOutNext(desk, book().read)) ?? "";
    expect(c).toBeTruthy();
    await ask(desk, c);
    hidden = new Set([...hidden].slice(1));
    setSystemTime(new Date(clock().getTime() + 11 * MIN));
    expect(await handOutNext(desk, book().read)).toBeUndefined();
  } finally {
    MATTERS = [matterOf("mat_a"), matterOf("mat_b")];
  }
});

// Finding 3 of the action pipeline review (20 Nov 2026): a hand-out that ended held its matter 7 days, then the same
// matter, unchanged, was handed out again and he was asked the same thing twice.
test("a matter whose hand-out ended is not handed out again a week later without a new step, and is after one", async () => {
  const desk = deskOf();
  const first = (await handOutNext(desk, book().read)) ?? "";
  await finish(desk, byId(desk, first), "nothing left for me");
  expect(agentOf(desk.db, personal)?.status).toBe("active");
  MATTERS = [matterOf("mat_a")];
  try {
    setSystemTime(new Date(clock().getTime() + 8 * DAY));
    expect(await handOutNext(desk, book().read)).toBeUndefined();
    MATTERS = [matterOf("mat_a", clock().toISOString())];
    setSystemTime(new Date(clock().getTime() + 11 * MIN));
    expect(await handOutNext(desk, book().read)).toBeTruthy();
  } finally {
    MATTERS = [matterOf("mat_a"), matterOf("mat_b")];
  }
});

test("a handed-out agent's packet carries the one-card first turn, a plain agent's the plan", async () => {
  const desk = deskOf();
  const handed = await handOutNext(desk, book().read);
  const plain = register(desk, {
    brief: "Test brief",
    runtime: "claude",
  });
  const one = await readPacket(desk, byId(desk, handed ?? ""), false);
  const two = await readPacket(desk, on(desk, plain), false);
  expect(one).toContain("Life handed you this matter");
  // Every card of a handed-out agent lets him drop the matter: it closes in Life on his pick.
  expect(one).toContain(
    'Every card also offers Drop it, marked `ends: "matter"`'
  );
  expect(one).not.toContain("Start with this plan?");
  expect(two).toContain("Start with this plan?");
  expect(two).not.toContain("Life handed you this matter");
  expect(byId(desk, handed ?? "").opened_by).toBe("desk");
});

/** The matters the hand-out may start an agent on (no gate, no hold: `handOutGateOf`), as the real read gives them. */
const readToDo = async () => {
  const { facts, matters } = await readHandOutMatters();
  return {
    facts,
    matters: matters.filter(
      (m) =>
        handOutGateOf(m, {
          ...facts,
          agentFor: () => "agt_000000000001",
          isHeld: () => undefined,
        }) === null
    ),
  };
};

/** The events queued for assignment `id`. */
const queued = (desk: ReturnType<typeof deskOf>, id: string) =>
  desk.db
    .query<{ name: string }, [string]>(
      "select name from event where assignment_id = ?"
    )
    .all(id)
    .map((r) => r.name);

// Regression, 20 Nov 2026: he answered "Done" on a handed-out agent's card about what only he could do; nothing closed
// in Life, so the matter stayed at the top of his ranking and the hand-out would start an agent on it again. His answer
// may wake the agent for one turn; closing its assignment on its matter is `endAgentsOnOverMatters`' alone
// (`endOutcomeOf`), and the standing agent that held it stays (the agents and matters plan, PR 3).
test("Done on an `ends: matter` card closes the matter: off the matters to do; its assignment is closed by endAgentsOnOverMatters, its agent stays", async () => {
  const desk = deskOf();
  const step = "obs_00000000f001";
  const matterId = "matter_00000000f001";
  await withBook(
    [toDo(step, "I'll pay the plumber")],
    { id: matterId, steps: [step] },
    async () => {
      await recordCorrection({
        goal: "The plumber is paid",
        kind: "matter-direction",
        nextStep: { kind: "do", text: "Pay the plumber" },
        steps: [step],
      });
      expect((await readToDo()).matters.map((m) => m.id)).toEqual([matterId]);
      const handed = (await handOutNext(desk, readToDo)) ?? "";
      await wakeDue(desk);
      // The desk reads his answers from here on.
      pollAnswers(desk);
      const { id } = await askDecision(desk, byId(desk, handed), {
        deadline: iso(clock().getTime() + DAY),
        onSilence: null,
        options: [
          { ends: "matter", id: "done", label: "Done" },
          { id: "tell", label: "Tell the agent…" },
        ],
        question: "Did you pay the plumber?",
        subject: matterId,
        title: "Pay the plumber",
      });
      await answerWithResult(
        id,
        { options: ["done"] },
        { report: () => undefined }
      );
      expect(readCorrections()).toMatchObject([
        { kind: "matter-direction" },
        { kind: "outdated", observations: [step] },
      ]);
      expect((await readToDo()).matters).toEqual([]);
      setSystemTime(new Date(clock().getTime() + 1000));
      pollAnswers(desk);
      expect(queued(desk, handed)).toEqual([DECISION_ANSWERED]);
      await endAgentsOnOverMatters(desk, readPeopleOnce());
      expect(byId(desk, handed).outcome).toBe(MATTER_DONE_OUTCOME);
      expect(agentOf(desk.db, personal)?.status).toBe("active");
    }
  );
});

// Regression, 20 Nov 2026 (the debt verdict on PR 1): until the door checks a card's subject and the fold moves matters,
// a card stays with its asker: one agent's card on a step another agent holds fills the asker's slot, not the holder's,
// and his answer wakes the asker.
test("a card on a step another agent holds stays with its asker: its slot, and his answer", async () => {
  const desk = deskOf();
  const [mine, theirs] = ["obs_00000000f041", "obs_00000000f042"];
  await withBook(
    [toDo(mine, "I'll call the roofer"), toDo(theirs, "I'll send the quote")],
    { id: "matter_00000000f041", steps: [mine, theirs] },
    async () => {
      const asker = register(desk, {
        brief: "Test brief",
        runtime: "claude",
        steps: [mine],
      });
      const holder = register(desk, {
        brief: "Test brief",
        runtime: "claude",
        steps: [theirs],
      });
      pollAnswers(desk);
      const card = (agent: string, title: string) =>
        askDecision(desk, on(desk, agent), {
          deadline: iso(clock().getTime() + DAY),
          onSilence: null,
          options: [
            { id: "yes", label: "Yes" },
            { id: "tell", label: "Tell the agent…" },
          ],
          question: "Send the quote?",
          subject: theirs,
          title,
        });
      const { id } = await card(asker, "Send the quote");
      await expect(card(asker, "Send it again")).rejects.toThrow(
        `${asker} already asks ${id}`
      );
      const { id: own } = await card(holder, "The holder's own");
      await answerWithResult(
        id,
        { options: ["yes"] },
        { report: () => undefined }
      );
      setSystemTime(new Date(clock().getTime() + 1000));
      pollAnswers(desk);
      expect(queued(desk, asgOf(desk, asker))).toEqual([DECISION_ANSWERED]);
      expect(queued(desk, asgOf(desk, holder))).toEqual([]);
      await withdrawOpenCards(desk.db, on(desk, holder), `test over ${own}`);
    }
  );
});

test("a project agent's `ends: step` card answered Done wakes it and never ends it", async () => {
  const desk = deskOf();
  const step = "obs_00000000f031";
  await withBook(
    [toDo(step, "I'll send the invoice")],
    { id: "matter_00000000f031", steps: [step] },
    async () => {
      const agent = register(desk, {
        brief: "Test brief: the bakery",
        project: "test-bakery",
        runtime: "claude",
      });
      pollAnswers(desk);
      const { id } = await askDecision(desk, on(desk, agent), {
        deadline: iso(clock().getTime() + DAY),
        onSilence: null,
        options: [
          { ends: "step", id: "done", label: "Done" },
          { id: "tell", label: "Tell the agent…" },
        ],
        question: "Did you send the invoice?",
        subject: step,
        title: "Send the invoice",
      });
      await answerWithResult(
        id,
        { options: ["done"] },
        { report: () => undefined }
      );
      setSystemTime(new Date(clock().getTime() + 1000));
      pollAnswers(desk);
      await endAgentsOnOverMatters(desk, readPeopleOnce());
      await wakeDue(desk);
      expect(agentOf(desk.db, agent)?.status).toBe("active");
      expect(
        desk.db
          .query<{ cause: string }, [string]>(
            "select cause from turn where agent_id = ? order by id desc limit 1"
          )
          .get(agent)
      ).toEqual({ cause: "answer" });
    }
  );
});

// Regression (the agents and matters plan, PR 3; his word of 20 Nov 2026): today's matter agents are folded into the
// standing agent that takes their matter, never finished under the old rules.
test("a matter agent with a wait, an open card and notes is folded: the agent that takes it holds them, his answer wakes it, the old agent ends, no turn is cut", async () => {
  const desk = deskOf();
  desk.embedder = null;
  const step = "obs_00000000f051";
  await withBook(
    [toDo(step, "I'll book the piano tuner")],
    { id: "matter_00000000f051", steps: [step] },
    async () => {
      const old = register(desk, {
        brief: "Test brief: the piano",
        runtime: "claude",
        steps: [step],
      });
      pollAnswers(desk);
      const s = on(desk, old);
      const { id: card } = await askDecision(desk, s, {
        deadline: iso(clock().getTime() + DAY),
        onSilence: null,
        options: [
          { id: "yes", label: "Yes" },
          { id: "tell", label: "Tell the agent…" },
        ],
        question: "Book Tuesday?",
        subject: step,
        title: "The piano tuner",
      });
      const wait = {
        events: [{ chat: "Test Tuner", from_me: false }],
        reason: "the tuner's reply",
        until: iso(clock().getTime() + DAY),
      };
      writeWait(desk.db, s.id, wait, false);
      writeNotes(desk, s, "Test notes: Tuesday suits him");
      // A turn of the old agent runs: nothing moves until it ends.
      desk.db.run(
        "insert into turn (agent_id, assignment_id, cause, started_at) values (?, ?, 'event', ?)",
        [old, s.id, clock().toISOString()]
      );
      await foldAssignments(desk, readPeopleOnce());
      expect(byId(desk, s.id).agent_id).toBe(old);
      desk.db.run("update turn set ended_at = ?, outcome = 'waited'", [
        clock().toISOString(),
      ]);
      await foldAssignments(desk, readPeopleOnce());
      const moved = byId(desk, s.id);
      expect(moved).toMatchObject({
        agent_id: personal,
        notes_path: s.notes_path,
        wait_reason: wait.reason,
        wait_until: wait.until,
      });
      expect(readNotes(moved)).toBe("Test notes: Tuesday suits him");
      expect(agentOf(desk.db, old)).toMatchObject({
        outcome: `folded into the ${personal} agent`,
        status: "ended",
      });
      expect(agentOf(desk.db, personal)?.status).toBe("active");
      // The card stays on its matter: his answer wakes the agent that holds it now.
      await answerWithResult(
        card,
        { options: ["yes"] },
        { report: () => undefined }
      );
      setSystemTime(new Date(clock().getTime() + 1000));
      pollAnswers(desk);
      expect(queued(desk, s.id)).toEqual([DECISION_ANSWERED]);
      await wakeDue(desk);
      expect(
        desk.db
          .query<{ agent_id: string; cause: string }, [string]>(
            "select agent_id, cause from turn where assignment_id = ? order by id desc limit 1"
          )
          .get(s.id)
      ).toEqual({ agent_id: personal, cause: "answer" });
    }
  );
});

// Finding 8 of the action pipeline review (20 Nov 2026): steps change only at night, so the hand-out could start on a
// next step that today's news had already overtaken. A step the direction was not drafted on makes it due again.
test("a matter whose direction is due (a step its next step was not drafted on) is not a matter to do", async () => {
  const [first, second] = ["obs_00000000f011", "obs_00000000f012"];
  await withBook(
    [toDo(first, "I'll pay the plumber"), toDo(second, "pay him by Friday")],
    { id: "matter_00000000f011", steps: [first, second] },
    async () => {
      await recordCorrection({
        goal: "The plumber is paid",
        kind: "matter-direction",
        nextStep: { kind: "do", text: "Pay the plumber" },
        steps: [first],
      });
      expect((await readToDo()).matters).toEqual([]);
    }
  );
});

// Finding 5 of the action pipeline review (20 Nov 2026): a lone matter leaves the book once it closes, so its agent was
// never found on a matter, never ended, and its card came back.
test("an assignment on a lone matter that closed is closed; one on a step no matter holds that is still open is not; their agent stays", async () => {
  const desk = deskOf();
  const [lone, open] = ["obs_00000000f021", "obs_00000000f022"];
  await withBook(
    [toDo(lone, "I'll call the bank"), toDo(open, "I'll call the school")],
    null,
    async () => {
      const startOn = (step: string) =>
        openAssignment(desk, personal, { openedBy: "desk", steps: [step] });
      const ended = startOn(lone);
      const stays = startOn(open);
      await recordCorrection({
        kind: "outdated",
        note: "test: done",
        observations: [lone],
      });
      await endAgentsOnOverMatters(desk, readPeopleOnce());
      expect(byId(desk, ended).outcome).toBe(MATTER_DONE_OUTCOME);
      expect(byId(desk, stays).closed_at).toBeNull();
      expect(agentOf(desk.db, personal)?.status).toBe("active");
    }
  );
});

// The give-back: a handed-out assignment that asked no card in time is closed; its agent stays.

/** A hand-out whose first turn began now: its assignment's id. */
const handedOut = async (desk: ReturnType<typeof deskOf>) => {
  const id = (await handOutNext(desk, book().read)) ?? "";
  // A session already open is shown its matter's record, read from the book.
  await withMatters(views(), () => wakeDue(desk));
  desk.db.run("update turn set begun_at = ? where assignment_id = ?", [
    clock().toISOString(),
    id,
  ]);
  return id;
};

test("a card asked in time keeps the assignment; none at 2 hours closes it with its outcome and stops its run; the agent stays", async () => {
  const t = setup();
  const desk = deskOf(t);
  const asked = await handedOut(desk);
  await ask(desk, asked);
  // Its turn ends: the agent takes one turn at a time.
  await t.end(personal);
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  const silent = await handedOut(desk);
  // Its first turn began on the agent's session.
  expect(countOf(desk, `turn where assignment_id = '${silent}'`)).toBe(1);
  setSystemTime(new Date(clock().getTime() + 2 * HOUR));
  await endAgentsWithoutCard(desk);
  expect(byId(desk, asked).closed_at).toBeNull();
  expect(byId(desk, silent).outcome).toBe(NO_CARD_OUTCOME);
  const a = agentOf(desk.db, personal);
  expect(a?.status).toBe("active");
  expect(t.fake.stopped).toEqual([a?.session ?? ""]);
  await withdrawOpenCards(desk.db, byId(desk, asked), "test over");
});

test("an agent he started himself is never ended for asking no card", async () => {
  const desk = deskOf();
  const id = register(desk, { brief: "Test brief", runtime: "claude" });
  await wakeDue(desk);
  desk.db.run("update turn set begun_at = ? where agent_id = ?", [
    clock().toISOString(),
    id,
  ]);
  setSystemTime(new Date(clock().getTime() + 3 * HOUR));
  await endAgentsWithoutCard(desk);
  expect(agentOf(desk.db, id)?.status).toBe("active");
});

test("a hand-out whose first turn never began is not picked again", async () => {
  const desk = deskOf();
  const { read } = book();
  const first = (await handOutNext(desk, read)) ?? "";
  desk.db.run(
    "update assignment set closed_at = ?, why_not_started = 'test' where id = ?",
    [clock().toISOString(), first]
  );
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  const second = (await handOutNext(desk, read)) ?? "";
  const steps = (id: string) =>
    desk.db
      .query<{ step: string }, [string]>(
        "select step from anchor where assignment_id = ?"
      )
      .all(id)
      .map((r) => r.step);
  expect(steps(first)).toEqual(["obs_a1"]);
  expect(steps(second)).toEqual(["obs_b1"]);
});

test("the 2 hours run from the first turn's beginning, not the agent's creation", async () => {
  const desk = deskOf();
  const id = (await handOutNext(desk, book().read)) ?? "";
  setSystemTime(new Date(clock().getTime() + HOUR));
  await wakeDue(desk);
  desk.db.run("update turn set begun_at = ? where assignment_id = ?", [
    clock().toISOString(),
    id,
  ]);
  setSystemTime(new Date(clock().getTime() + HOUR + 30 * MIN));
  await endAgentsWithoutCard(desk);
  expect(byId(desk, id).closed_at).toBeNull();
  setSystemTime(new Date(clock().getTime() + 31 * MIN));
  await endAgentsWithoutCard(desk);
  expect(byId(desk, id).outcome).toBe(NO_CARD_OUTCOME);
  expect(agentOf(desk.db, personal)?.status).toBe("active");
});
