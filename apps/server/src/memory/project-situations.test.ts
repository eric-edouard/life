import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { writeJson } from "../core/files";
import { promptNameOf } from "../models/prompt-parts";
import { ProjectSituationLine } from "../records/situation";
import type { MatterView } from "./matter-read";
import {
  projectSituationPath,
  readProjectSituationNow,
} from "./project-situation-read";
import { projectInputOf, projectTargetsOf } from "./project-situations";
import { projectStepRefsOf } from "./read-matters";
import { inputsOf } from "./run";
import { shownLines } from "./situations";
import type { People } from "./who";

const ID = "test-harbor";
const S1 = "obs_aaaaaaaaaaaa";
const S2 = "obs_bbbbbbbbbbbb";

afterEach(() => rm(projectSituationPath(ID), { force: true }));

const step = (ref: string, text = "Quote sent") => ({
  at: "2026-11-10T09:00:00Z",
  day: "2026-11-10",
  kind: "promise",
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
    openSteps: [],
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

const store = (prompt = promptNameOf("memory-project-situation.v1")) =>
  writeJson(projectSituationPath(ID), {
    built: "2026-11-10T00:00:00.000Z",
    inputs: "0123456789abcdef",
    lines: [
      { cites: [S1], text: "The quote went out on 10 Nov." },
      { cites: [S2], text: "A step since re-grouped away." },
    ],
    madeBy: { engine: "claude", model: "m", prompt, run: "r" },
    project: ID,
    schemaVersion: 1,
  });

test("a reader shows only lines whose steps a matter of the project still holds", () => {
  store();
  expect(readProjectSituationNow(ID, new Set([S1])).map((l) => l.text)).toEqual(
    ["The quote went out on 10 Nov."]
  );
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
  expect(projectTargetsOf([running], people(project("active")))).toHaveLength(
    1
  );
  expect(projectTargetsOf([running], people(project("waiting")))).toHaveLength(
    1
  );
  expect(projectTargetsOf([running], people(project("parked")))).toEqual([]);
  expect(projectTargetsOf([running], people(project("done")))).toEqual([]);
  expect(projectTargetsOf([dormant], people(project("active")))).toEqual([]);
  expect(
    projectTargetsOf(
      [matter({ projects: ["other"] })],
      people(project("active"))
    )
  ).toEqual([]);
});

test("the digest moves with the matters' words and the entry, never with a status that follows the clock", () => {
  const digestOf = (m: MatterView, notes = "") => {
    const [t] = projectTargetsOf([m], people(project("active", notes)));
    return inputsOf(
      "p",
      projectInputOf(t, (r) => r)
    );
  };
  const base = digestOf(matter());
  expect(digestOf(matter({ status: "stuck" } as Partial<MatterView>))).toBe(
    base
  );
  expect(digestOf(matter({ steps: [step(S1), step(S2, "Paid")] }))).not.toBe(
    base
  );
  expect(digestOf(matter(), "Owner note")).not.toBe(base);
});

test("a reply keeps only lines citing steps the call was shown", () => {
  const reply = {
    lines: [
      { cites: [S1], text: "Kept." },
      { cites: [S1, S2], text: "Cites one not shown." },
      { cites: [], text: "Cites nothing." },
    ],
  };
  expect(
    shownLines(reply, new Set([S1]), ProjectSituationLine).map((l) => l.text)
  ).toEqual(["Kept."]);
});
