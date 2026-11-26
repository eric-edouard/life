import { afterEach, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { writeJson } from "../core/files";
import { promptNameOf } from "../models/prompt-parts";
import { type MatterView, nextStepNow } from "./matter-read";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matters from "./matters";
import {
  projectInputOf,
  projectSituations,
  projectTargetsOf,
} from "./project-situations";
import { projectStepRefsOf } from "./read-matters";
import { inputsOf } from "./run";
import {
  projectSituationPath,
  readProjectSituationNow,
} from "./situation-parts";
import type { People } from "./who";

const ID = "test-harbor";
const S1 = "obs_aaaaaaaaaaaa";
const S2 = "obs_bbbbbbbbbbbb";

afterEach(() => rm(projectSituationPath(ID), { force: true }));

const step = (ref: string, text = "Quote sent") => ({
  at: "2026-11-10T09:00:00Z",
  day: "2026-11-10",
  kind: "promise" as const,
  quote: "",
  ref,
  text,
});
const matter = (
  over: Partial<MatterView> & { projects?: string[] } = {}
): MatterView =>
  ({
    name: "Boat repair",
    open: true,
    openSteps: [step(S1)],
    projects: [ID],
    status: "moving",
    steps: [step(S1)],
    ...over,
  }) as unknown as MatterView;
const project = (status: string, notes = "") => ({
  deadlines: [{ date: "2026-12-01", what: "Haul-out" }],
  id: ID,
  name: "Harbor",
  notes,
  status,
});
const people = (...projects: ReturnType<typeof project>[]) =>
  ({ nameOf: (r: string) => r, truth: { projects } }) as unknown as People;

const store = (prompt = promptNameOf("memory-project-situation.v2")) =>
  writeJson(projectSituationPath(ID), {
    built: "2026-11-10T00:00:00.000Z",
    inputs: "0123456789abcdef",
    madeBy: { engine: "claude", model: "m", prompt, run: "r" },
    parts: [
      { cites: [S1], markdown: "You sent the quote on 10 Nov." },
      { cites: [S2], markdown: "A step since re-grouped away." },
    ],
    schemaVersion: 2,
    subject: ID,
  });

test("a reader shows only parts whose steps a matter of the project still holds", () => {
  store();
  expect(
    readProjectSituationNow(ID, new Set([S1])).map((p) => p.markdown)
  ).toEqual(["You sent the quote on 10 Nov."]);
  expect(readProjectSituationNow(ID, new Set())).toEqual([]);
});

test("a situation made by another prompt variant is hidden at once", () => {
  store("memory-project-situation.v0");
  expect(readProjectSituationNow(ID, new Set([S1, S2]))).toEqual([]);
});

test("a project's steps are those of the matters showing under it, dormant or not", () => {
  const truth = { projects: [project("active")] } as unknown as Parameters<
    typeof projectStepRefsOf
  >[0];
  const book = [
    matter(),
    matter({ status: "dormant", steps: [step(S2)] }),
    matter({ projects: ["other"], steps: [step("obs_cccccccccccc")] }),
  ];
  expect([...projectStepRefsOf(truth, book, ID)].toSorted()).toEqual([S1, S2]);
});

test("only a project underway with a running matter gets a situation", () => {
  const running = matter();
  const dormant = matter({ status: "dormant" } as Partial<MatterView>);
  expect(
    projectTargetsOf([running], people(project("active")), [])
  ).toHaveLength(1);
  expect(
    projectTargetsOf([running], people(project("waiting")), [])
  ).toHaveLength(1);
  expect(projectTargetsOf([running], people(project("parked")), [])).toEqual(
    []
  );
  expect(projectTargetsOf([running], people(project("done")), [])).toEqual([]);
  expect(projectTargetsOf([dormant], people(project("active")), [])).toEqual(
    []
  );
  expect(
    projectTargetsOf(
      [matter({ projects: ["other"] })],
      people(project("active")),
      []
    )
  ).toEqual([]);
});

const digestOf = (book: MatterView[], notes = "", name = "Harbor") => {
  const [t] = projectTargetsOf(
    book,
    people({ ...project("active", notes), name }),
    []
  );
  if (!t) {
    throw new Error("no target");
  }
  return inputsOf("p", projectInputOf(t, []));
};

test("the digest moves with the matters' words and the entry, never with a status that follows the clock", () => {
  const base = digestOf([matter()]);
  expect(digestOf([matter({ status: "stuck" } as Partial<MatterView>)])).toBe(
    base
  );
  expect(digestOf([matter({ steps: [step(S1), step(S2, "Paid")] })])).not.toBe(
    base
  );
  expect(digestOf([matter()], "Owner note")).not.toBe(base);
});

test("a sibling matter going dormant, or a renamed project, matter or person, changes no digest", () => {
  const sibling = matter({ name: "Paint", steps: [step(S2, "Paint bought")] });
  const base = digestOf([matter(), sibling]);
  const dormant = { ...sibling, status: "dormant" } as MatterView;
  expect(digestOf([matter(), dormant])).toBe(base);
  expect(digestOf([matter(), sibling], "", "Harbour")).toBe(base);
  expect(
    digestOf([{ ...matter(), name: "Hull repair" } as MatterView, sibling])
  ).toBe(base);
  // The step's person is a ref in the digest, a name only in the call.
  const withAnna = matter({
    openSteps: [{ ...step(S1), with: "person:anna" }],
  } as Partial<MatterView>);
  expect(JSON.stringify(projectInputOf(targetOf(withAnna), []))).toContain(
    "person:anna"
  );
});

const targetOf = (m: MatterView) => {
  const [t] = projectTargetsOf([m], people(project("active")), []);
  if (!t) {
    throw new Error("no target");
  }
  return t;
};

test("a matter too large for one call keeps its project's situation: its steps are bounded", () => {
  const openSteps = Array.from({ length: 500 }, (_, i) =>
    step(`obs_${String(i).padStart(12, "0")}`, "x".repeat(400))
  );
  const big = matter({
    openSteps,
    steps: openSteps,
  } as Partial<MatterView>);
  const t = targetOf(big);
  expect(t.matters).toHaveLength(1);
  expect(JSON.stringify(projectInputOf(t, [])).length).toBeLessThan(30_000);
});

test("a matter open only for being recent is not shown: its closing with the clock regenerates nothing", () => {
  const sibling = matter({ name: "Paint", steps: [step(S2, "Painted")] });
  const recent = { ...sibling, openSteps: [] } as MatterView;
  const base = digestOf([matter(), recent]);
  expect(digestOf([matter(), { ...recent, open: false } as MatterView])).toBe(
    base
  );
  expect(digestOf([matter()])).toBe(base);
});

test("the size a matter is packed at is what the call renders: names and statuses too", () => {
  const books = Array.from({ length: 200 }, (_, i) =>
    matter({
      name: "N".repeat(100),
      openSteps: [step(`obs_${String(i).padStart(12, "0")}`, "x".repeat(150))],
      status: "moving",
    })
  );
  const [t] = projectTargetsOf(books, people(project("active")), []);
  const rendered = JSON.stringify(
    t?.matters.map((v) => ({ ...v, name: v.name, status: v.status }))
  );
  expect(t?.matters.length).toBeGreaterThan(0);
  expect(t?.matters.length).toBeLessThan(200);
  expect(rendered.length).toBeLessThan(40_000);
});

test("an open decision shows as his pending decision, not the draft next step", () => {
  const m = matter({
    nextStep: { kind: "do", text: "Send the quote" },
  } as Partial<MatterView>);
  const decisions = [{ question: "Approve the quote?", subject: S1 }] as never;
  expect(
    JSON.stringify(
      projectInputOf(
        {
          ...targetOf(m),
          matters: [m],
        },
        decisions
      )
    )
  ).toContain("Approve the quote?");
  expect(nextStepNow(m, [])?.text).toBe("Send the quote");
});

test("a night with nothing changed reads no history: the records come from the night, and a built situation is not asked again", async () => {
  const models = await import("../models/llm");
  const book = matter({ steps: [step(S1)] });
  const bookOf = spyOn(matters, "matterBookAgain").mockReturnValue([book]);
  const records = spyOn(matters, "readMatterRecords");
  const ask = spyOn(models, "askOnce").mockResolvedValue({
    parts: [{ cites: [S1], markdown: "You sent the quote." }],
  } as never);
  const p = {
    nameOf: (r: string) => r,
    truth: {
      areas: [],
      me: { text: "" },
      projects: [{ ...project("active"), notes: "", repos: [] }],
    },
  } as unknown as People;
  try {
    const night = {} as never;
    await projectSituations(p, night);
    await projectSituations(p, night);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(records).not.toHaveBeenCalled();
  } finally {
    bookOf.mockRestore();
    records.mockRestore();
    ask.mockRestore();
  }
});
