import { expect, test } from "bun:test";
import { Person, Project } from "../records/truth";
import { involvedOf, phases, record, refContext } from "./run";
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
      areas: [],
      chats: [],
      me: { text: "me" },
      people: [person("ann"), person("bob"), person("cy")],
      projects: [project("app", "active"), project("old", "done")],
    },
    [],
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
