import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clock, DAY, HOUR, iso, MIN } from "../core/clock";
import { setSettings, settings } from "../core/settings";
import { answerWithResult } from "../host/answer-result";
import { agentOf } from "../host/desk-read";
import { DECISION_ANSWERED } from "../host/events";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as checks from "../memory/checks";
import { DECISIONS, decisionsNow } from "../memory/decisions";
import { MATTERS_PROMPT } from "../memory/matters";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as memoryFiles from "../memory/memory-files";
import {
  CORRECTIONS,
  MATTERS as MATTERS_FILE,
  readCorrections,
  recordCorrection,
} from "../memory/memory-files";
import { mattersToDo } from "../memory/read-matters";
import { OWNER } from "../memory/read-truth";
import { dayNow, dayStart, zoneNow } from "../memory/zones";
import type { Observation } from "../records/observation";
import { TOP_AT } from "../records/unit";
import {
  askDecision,
  finish,
  readPacket,
  register,
  withdrawOpenDecision,
} from "./agent-actions";
import {
  endAgentsOnOverMatters,
  pollAnswers,
  readPeopleOnce,
  wakeDue,
} from "./desk-clock";
import { NO_CARD_OUTCOME } from "./hand-out";
import { endAgentsWithoutCard, handOutNext } from "./hand-out-tick";
import { MATTER_DONE_OUTCOME } from "./matter-net";
import { setup } from "./test-desk";

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
  projects: [],
  steps: [{ at, ref: `obs_${id.slice(4)}1` }],
});
let MATTERS = [matterOf("mat_a"), matterOf("mat_b")];
const book = () => {
  const reads = { n: 0 };
  return {
    read: () => {
      reads.n += 1;
      return Promise.resolve({ dismissed: [], matters: MATTERS });
    },
    reads,
  };
};
const deskOf = () => {
  const t = setup();
  t.desk.runtimes = { claude: t.fake.runtime };
  return t.desk;
};
const agentsOf = (desk: ReturnType<typeof deskOf>) =>
  desk.db
    .query<{ id: string; is_handed_out: number; brief: string }, []>(
      "select id, is_handed_out, brief from agent order by rowid"
    )
    .all();

test("one agent starts on the top matter, marked handed out, and none again within 10 minutes", async () => {
  const desk = deskOf();
  const { read, reads } = book();
  const id = await handOutNext(desk, read);
  expect(id).toBeTruthy();
  expect(agentsOf(desk)).toHaveLength(1);
  expect(agentsOf(desk)[0]?.is_handed_out).toBe(1);
  const anchored = desk.db
    .query<{ step: string }, [string]>(
      "select step from anchor where agent_id = ?"
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
  expect(agentsOf(desk)).toHaveLength(2);
});

test("with no setting the hand-out is off and reads nothing", async () => {
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
  const desk = deskOf();
  const { read, reads } = book();
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(0);
  expect(agentsOf(desk)).toHaveLength(0);
});

test("a look under the daily cap reads no matter book", async () => {
  const desk = deskOf();
  const { read, reads } = book();
  await handOutNext(desk, read);
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  await handOutNext(desk, read);
  expect(agentsOf(desk)).toHaveLength(2);
  const before = reads.n;
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(before);
});

test("a blocked default runtime starts nothing, and the look still counts", async () => {
  const t = setup();
  t.desk.runtimes = { claude: t.fake.runtime };
  t.fake.blocked = "Test: not logged in";
  const { read, reads } = book();
  expect(await handOutNext(t.desk, read)).toBeUndefined();
  expect(reads.n).toBe(0);
  t.fake.blocked = undefined;
  setSystemTime(new Date(clock().getTime() + 9 * MIN));
  expect(await handOutNext(t.desk, read)).toBeUndefined();
  setSystemTime(new Date(clock().getTime() + 2 * MIN));
  expect(await handOutNext(t.desk, read)).toBeTruthy();
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
      "update agent set is_handed_out = 1, created_at = ? where id = ?",
      [new Date(at).toISOString(), id]
    );
  markAt(old, since.getTime() - MIN);
  expect(await handOutNext(desk, read)).toBeTruthy();
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(1);
});

const ask = (desk: ReturnType<typeof deskOf>, id: string) =>
  askDecision(desk, id, {
    deadline: iso(clock().getTime() + DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: send this?",
    title: "a test",
  });
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
  await finish(desk, first, "nothing left for me");
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
  const one = await readPacket(desk, handed ?? "", false);
  const two = await readPacket(desk, plain, false);
  expect(one).toContain("Life handed you this matter");
  // Every card of a handed-out agent lets him drop the matter: it closes in Life on his pick.
  expect(one).toContain(
    'Every card also offers Drop it, marked `ends: "matter"`'
  );
  expect(one).not.toContain("Start with this plan?");
  expect(two).toContain("Start with this plan?");
  expect(two).not.toContain("Life handed you this matter");
  expect(agentOf(desk.db, handed ?? "")?.is_handed_out).toBe(1);
});

/** His own to-do `id`, said today: a made-up observation. */
const toDo = (id: string, quote: string): Observation =>
  ({
    area: null,
    at: clock().toISOString(),
    confidence: 0.9,
    date: dayNow(),
    id,
    importance: TOP_AT,
    madeBy: {
      engine: "claude",
      model: "test",
      prompt: "test",
      run: "test",
      unitHash: "h",
    },
    quote,
    schemaVersion: 1,
    source: { channel: "whatsapp", ref: `m-${id}` },
    speaker: OWNER,
    subjects: [],
    text: quote,
    type: "to_do",
    tz: "UTC",
    unit: `unit_${id.slice(4)}`,
    validFrom: null,
    validTo: null,
    when: null,
  }) as Observation;

/**
 * Runs `f` over the real matter book made of `observations` and, when given, one matter line holding `steps` (its id
 * `matterId`); only the observations' and the live units' reads are faked. Cleans every file it wrote.
 */
async function withBook(
  observations: Observation[],
  line: { id: string; steps: string[] } | null,
  f: () => Promise<void>
) {
  mkdirSync(dirname(MATTERS_FILE), { recursive: true });
  writeFileSync(
    MATTERS_FILE,
    `${JSON.stringify({
      at: clock().toISOString(),
      madeBy: {
        engine: "claude",
        model: "test",
        prompt: MATTERS_PROMPT,
        run: "t",
      },
      matters: line
        ? [
            {
              areas: [],
              id: line.id,
              name: "Pay the plumber",
              projects: [],
              steps: line.steps.map((ref) => ({
                day: dayNow(),
                quote: "pay the plumber",
                ref,
              })),
            },
          ]
        : [],
      offered: observations.map((o) => o.id),
      schemaVersion: 1,
    })}\n`
  );
  const read = spyOn(memoryFiles, "readObservations").mockResolvedValue(
    observations
  );
  const live = spyOn(memoryFiles, "readLiveUnits").mockResolvedValue(
    new Set(observations.map((o) => o.unit))
  );
  try {
    await f();
  } finally {
    read.mockRestore();
    live.mockRestore();
    rmSync(MATTERS_FILE, { force: true });
    rmSync(CORRECTIONS, { force: true });
  }
}

const readToDo = async () => ({
  dismissed: [],
  matters: await mattersToDo(),
});

const queued = (desk: ReturnType<typeof deskOf>, agent: string) =>
  desk.db
    .query<{ name: string }, [string]>(
      "select name from event where agent_id = ?"
    )
    .all(agent)
    .map((r) => r.name);

// Regression, 20 Nov 2026: he answered "Done" on a handed-out agent's card about what only he could do; nothing closed
// in Life, so the matter stayed at the top of his ranking and the hand-out would start an agent on it again. His answer
// may wake the agent for one turn; ending it on its matter is `endAgentsOnOverMatters`' alone (`endOutcomeOf`).
test("Done on an `ends: matter` card closes the matter: off the matters to do; its agent is left to endAgentsOnOverMatters", async () => {
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
      const agent = (await handOutNext(desk, readToDo)) ?? "";
      await wakeDue(desk);
      // The desk reads his answers from here on.
      pollAnswers(desk);
      const { id } = await askDecision(desk, agent, {
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
      expect(agentOf(desk.db, agent)?.status).toBe("active");
      expect(queued(desk, agent)).toEqual([DECISION_ANSWERED]);
      await endAgentsOnOverMatters(desk, readPeopleOnce());
      expect(agentOf(desk.db, agent)).toMatchObject({
        outcome: MATTER_DONE_OUTCOME,
        status: "ended",
      });
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
      const { id } = await askDecision(desk, agent, {
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
test("an agent on a lone matter that closed is ended; one on a step no matter holds that is still open is not", async () => {
  const desk = deskOf();
  const [lone, open] = ["obs_00000000f021", "obs_00000000f022"];
  await withBook(
    [toDo(lone, "I'll call the bank"), toDo(open, "I'll call the school")],
    null,
    async () => {
      const on = (step: string) =>
        register(desk, {
          brief: "Test brief",
          kind: "handed_out",
          runtime: "claude",
          steps: [step],
        });
      const ended = on(lone);
      const stays = on(open);
      await recordCorrection({
        kind: "outdated",
        note: "test: done",
        observations: [lone],
      });
      await endAgentsOnOverMatters(desk, readPeopleOnce());
      expect(agentOf(desk.db, ended)).toMatchObject({
        outcome: MATTER_DONE_OUTCOME,
        status: "ended",
      });
      expect(agentOf(desk.db, stays)?.status).toBe("active");
    }
  );
});

// The give-back: a handed-out agent that asked no card in time is ended.

const handedOut = async (desk: ReturnType<typeof deskOf>) => {
  const id = (await handOutNext(desk, book().read)) ?? "";
  await wakeDue(desk);
  desk.db.run("update turn set begun_at = ? where agent_id = ?", [
    clock().toISOString(),
    id,
  ]);
  return id;
};
const cardOf = (desk: ReturnType<typeof deskOf>, id: string) =>
  askDecision(desk, id, {
    deadline: iso(clock().getTime() + DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: send this?",
    title: "a test",
  });

test("a card asked in time keeps the agent; none at 2 hours ends it with its outcome and stops its run", async () => {
  const t = setup();
  t.desk.runtimes = { claude: t.fake.runtime };
  const { desk } = t;
  const asked = await handedOut(desk);
  cardOf(desk, asked);
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  const silent = await handedOut(desk);
  setSystemTime(new Date(clock().getTime() + 2 * HOUR));
  await endAgentsWithoutCard(desk);
  expect(agentOf(desk.db, asked)?.status).toBe("active");
  const a = agentOf(desk.db, silent);
  expect(a?.status).toBe("ended");
  expect(a?.outcome).toBe(NO_CARD_OUTCOME);
  expect(t.fake.stopped).toEqual([a?.session ?? ""]);
  await withdrawOpenDecision(asked, "test over");
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
    "update agent set status = 'ended', ended_at = ?, why_not_started = 'test' where id = ?",
    [clock().toISOString(), first]
  );
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  const second = (await handOutNext(desk, read)) ?? "";
  const steps = (id: string) =>
    desk.db
      .query<{ step: string }, [string]>(
        "select step from anchor where agent_id = ?"
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
  desk.db.run("update turn set begun_at = ? where agent_id = ?", [
    clock().toISOString(),
    id,
  ]);
  setSystemTime(new Date(clock().getTime() + HOUR + 30 * MIN));
  await endAgentsWithoutCard(desk);
  expect(agentOf(desk.db, id)?.status).toBe("active");
  setSystemTime(new Date(clock().getTime() + 31 * MIN));
  await endAgentsWithoutCard(desk);
  expect(agentOf(desk.db, id)?.status).toBe("ended");
});
