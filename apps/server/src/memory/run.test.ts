import { expect, spyOn, test } from "bun:test";
import type { InferredPerson } from "../records/observation";
import { Person, Project } from "../records/truth";
import {
  begin,
  inputsOf,
  involvedOf,
  metered,
  phases,
  record,
  refContext,
} from "./run";
import { runs } from "./run-log";

/** The run as the status reads' `read_processing_runs` reads it back from the (test) log. */
const read = async (step: string, run: string) =>
  (await runs({ steps: [step] })).items.find((r) => r.id === `${step}/${run}`);

test("a run is logged as started, then ended with its duration, under its start instant", async () => {
  const step = "memory.test-ok";
  const rec = record(step, { days: 1 });
  const summary = rec.end({ calls: 2, outcome: "ok" });
  expect(summary).toEqual({
    calls: 2,
    ms: expect.any(Number),
    outcome: "ok",
    run: rec.run,
  });
  expect(await read(step, rec.run)).toMatchObject({
    errors: [],
    input: { days: 1 },
    outcome: "ok",
    result: { calls: 2, ms: summary.ms },
    startedAt: rec.now.toISOString(),
  });
});

test("a failure is the run's error, and its end says it failed", async () => {
  const step = "memory.test-failed";
  const rec = record(step, {});
  rec.error("offline", { unit: "u1" });
  rec.end({ error: "offline", failedAt: "triage", outcome: "failed" });
  expect(await read(step, rec.run)).toMatchObject({
    errors: [{ error: "offline", unit: "u1" }],
    outcome: "failed",
    result: { failedAt: "triage" },
  });
});

test("a sweep fails at the phase whose step failed anything, its errors and sub-steps' under its run", async () => {
  const step = "memory.midday";
  const rec = record(step, {});
  const phase = phases(rec);
  await phase.step("triage", async () => ({ failed: 0 }));
  rec.error("offline", { step: `${step}.push` });
  const failure = await phase
    .step("extract", async () => ({ failed: 2 }))
    .catch(phase.failed);
  rec.end(failure);
  expect(failure).toEqual({
    error: "2 failed",
    failedAt: "extract",
    outcome: "failed",
  });
  expect(await read(step, rec.run)).toMatchObject({
    errors: [
      { error: "offline", step: `${step}.push` },
      { error: "extract: 2 failed" },
    ],
    outcome: "failed",
    result: { failedAt: "extract" },
  });
});

test("a call's context shows the people close now and the projects underway; the rest of the map comes as involved", () => {
  const person = (id: string) => Person.parse({ id, name: id.toUpperCase() });
  const project = (id: string, status: Project["status"]) => ({
    ...Project.parse({ area: "work", id, name: id, schemaVersion: 1, status }),
    notes: "",
  });
  const refs = refContext(
    {
      canon: (ref) => ref,
      inferred: [],
      truth: {
        areas: [],
        chats: [],
        me: { text: "me" },
        people: [person("ann"), person("bob"), person("cy")],
        projects: [project("app", "active"), project("old", "done")],
      },
    },
    new Set(["person:bob"]),
    new Set(["person:ann"])
  );
  expect(refs.context.people.map((p) => p.ref)).toEqual(["person:ann"]);
  expect(refs.context.projects.map((p) => p.ref)).toEqual(["project:app"]);
  expect(refs.map.people.map((p) => p.ref)).toEqual([
    "person:ann",
    "person:bob",
    "person:cy",
  ]);
  const involved = involvedOf(
    refs,
    new Set(["person:ann", "person:bob", "project:old", "person:nobody"])
  );
  expect(involved.people.map((p) => [p.ref, p.close])).toEqual([
    ["person:bob", true],
  ]);
  expect(involved.projects.map((p) => [p.ref, p.status])).toEqual([
    ["project:old", "done"],
  ]);
});

test("the map shows each person once: an inferred id folded into another is left out", () => {
  const guess = (id: string) =>
    ({ confidence: 0.9, id, name: id, relation: "a guess" }) as InferredPerson;
  const refs = refContext(
    {
      canon: (ref) => (ref === "person:inf_ann" ? "person:ann" : ref),
      inferred: [guess("inf_ann"), guess("inf_dee")],
      truth: {
        areas: [],
        chats: [],
        me: { text: "me" },
        people: [Person.parse({ id: "ann", name: "Ann" })],
        projects: [],
      },
    },
    new Set(),
    new Set()
  );
  expect(refs.map.people.map((p) => p.ref)).toEqual([
    "person:ann",
    "person:inf_dee",
  ]);
});

test("a step uses its explicit engine without changing the ordinary engine", async () => {
  const step = await begin("test-engine", "fast", {}, "codex");
  expect(step.llm.engine).toBe("codex");
  expect(step.end({}).model).toContain("codex/");
});

test("a metered run reads only its explicit engine quota at start and end", async () => {
  const models = await import("../models/llm");
  const quota = spyOn(models, "quota").mockResolvedValue(undefined);
  try {
    const rec = await metered("memory.test-metered", {}, "codex");
    await rec.end({ outcome: "ok" });
    expect(quota.mock.calls).toEqual([["codex"], ["codex"]]);
  } finally {
    quota.mockRestore();
  }
});

test("a sweep's selected engine reaches collection, attachments, episodes and extraction", async () => {
  const sources = await import("./sources");
  const files = await import("./message-files");
  const steps = await import("./run");
  const { gather } = await import("./units");
  const { episodes } = await import("./episodes");
  const { extract } = await import("./extract");
  const { readPeople } = await import("./who");
  const ready = spyOn(sources, "readySources").mockReturnValue([]);
  const described = spyOn(files, "describeFiles").mockResolvedValue({
    calls: 0,
    copied: 0,
    described: 0,
    failed: 0,
    missing: [],
    model: "codex/test",
    ms: 0,
    read: 0,
    run: "test",
  });
  const stopped = new Error("engine inspected before model work");
  const started = spyOn(steps, "begin").mockRejectedValue(stopped);
  try {
    const evidence = await gather(
      { from: "2025-03-01", to: "2025-03-01" },
      await readPeople(),
      { engine: "codex" }
    );
    expect(described.mock.calls.at(0)?.[1]).toBe("codex");
    expect(evidence.engine).toBe("codex");
    await expect(episodes(evidence)).rejects.toThrow(stopped);
    await expect(extract(evidence)).rejects.toThrow(stopped);
    expect(started.mock.calls.map((args) => [args[0], args[3]])).toEqual([
      ["episodes", "codex"],
      ["extract", "codex"],
    ]);
  } finally {
    started.mockRestore();
    described.mockRestore();
    ready.mockRestore();
  }
});

test("a call's inputs digest is pinned: the one personas, situations and appointments kept (a change rebuilds them all)", () => {
  expect(inputsOf("memory-persona.v2", { a: 1 })).toBe("dba367e9d7038416");
  expect(inputsOf("p", { a: 1 })).not.toBe(inputsOf("q", { a: 1 }));
});
