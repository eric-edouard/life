import { expect, test } from "bun:test";
import { foldsOf } from "../memory/who";
import { type Correction, InferredPerson } from "../records/observation";
import { Person } from "../records/truth";
import { lifelogPeopleOf, lifelogPeopleSync } from "./lifelog-people";

const person = (id: string, lifelog?: string) =>
  Person.parse({
    aliases: [`${id} nickname`],
    handles: { lifelog },
    id,
    name: id === "dara" ? "Dara" : "Mali",
  });
const guess = (
  id: string,
  confidence: number,
  personRef: string | null = null
) =>
  InferredPerson.parse({
    area: null,
    at: "2026-11-10T00:00:00Z",
    confidence,
    evidence: [{ quote: "A made-up greeting", unit: "unit-made-up" }],
    id,
    madeBy: {
      engine: "codex",
      model: "model",
      prompt: "people.v1",
      run: "run",
    },
    name: "Dara",
    person: personRef,
    project: null,
    relation: "friend",
    schemaVersion: 1,
    surfaces: [id === "inf_old" ? "+66123456789" : id],
  });
function reading() {
  const people = [
    person("dara", "00000000-0000-4000-8000-000000000001"),
    person("mali"),
  ];
  const inferred = [
    guess("inf_old", 1, "person:dara"),
    guess("inf_faint", 0.1),
    guess("inf_new", 1),
  ];
  const corrections: Correction[] = [];
  return {
    corrections,
    inferred,
    truth: { people },
    ...foldsOf(people, inferred, corrections),
  };
}

test("snapshot contains canonical confident identities, names and explicit links, never phone surfaces", () => {
  const snapshot = lifelogPeopleOf(reading());
  expect(snapshot.people.map((p) => p.ref)).toEqual([
    "person:dara",
    "person:inf_new",
    "person:mali",
  ]);
  expect(snapshot.folds).toEqual({ "person:inf_old": "person:dara" });
  expect(snapshot.people[0]?.personId).toBe(
    "00000000-0000-4000-8000-000000000001"
  );
  expect(JSON.stringify(snapshot)).not.toContain("+66123456789");
  expect(JSON.stringify(snapshot)).not.toContain("inf_faint");
});

test("folded old explicit links survive an initial snapshot and chained folds use canon", () => {
  const read = reading();
  const corrections: Correction[] = [
    {
      at: "2026-11-10T00:00:00Z",
      from: "person:dara",
      kind: "same-person",
      schemaVersion: 1,
      to: "person:middle",
    },
    {
      at: "2026-11-10T00:00:00Z",
      from: "person:middle",
      kind: "same-person",
      schemaVersion: 1,
      to: "person:mali",
    },
  ];
  const source = {
    ...read,
    corrections,
    ...foldsOf(read.truth.people, read.inferred, corrections),
  };
  const snapshot = lifelogPeopleOf(source);
  expect(snapshot.folds["person:dara"]).toBe("person:mali");
  expect(snapshot.folds["person:middle"]).toBe("person:mali");
  expect(
    snapshot.people.find((p) => p.ref === "person:dara")?.personId
  ).toBeTruthy();
});

test("push precedes pass, unchanged snapshots replay and backfill engine alone enables Codex", async () => {
  let selected: string | undefined;
  let now = 100;
  const calls: { path: string; body: unknown; method?: string }[] = [];
  const sync = lifelogPeopleSync({
    enabled: () => true,
    engine: () => selected,
    now: () => now,
    read: async () => reading(),
    send: (path, _, body, method) => {
      calls.push({ body, method, path });
      return Promise.resolve({});
    },
  });
  await sync();
  selected = "claude";
  now = 101;
  await sync();
  expect(calls.map((c) => c.path)).toEqual(["/life/people", "/life/people"]);
  expect(calls[0]?.body).toEqual(calls[1]?.body);
  selected = "codex";
  await sync();
  expect(calls.slice(-2).map((c) => c.path)).toEqual([
    "/life/people",
    "/naming-pass",
  ]);
  expect(calls.at(-1)?.body).toEqual({ engine: "codex", mode: "arrivals" });
});

test("failed or disabled snapshot never starts the pass; a later tick retries", async () => {
  let enabled = false;
  const calls: string[] = [];
  const sync = lifelogPeopleSync({
    enabled: () => enabled,
    engine: () => "codex",
    now: () => 100,
    read: async () => reading(),
    send: (path) => {
      calls.push(path);
      if (calls.length === 1) {
        return Promise.reject(new Error("offline"));
      }
      return Promise.resolve({});
    },
  });
  await sync();
  expect(calls).toEqual([]);
  enabled = true;
  await expect(sync()).rejects.toThrow("offline");
  await sync();
  expect(calls).toEqual(["/life/people", "/life/people", "/naming-pass"]);
});

test("complete removal raises revision even if the clock went backward; concurrent ticks do not overlap", async () => {
  let source = reading();
  let now = 100;
  let release: (() => void) | undefined;
  const revisions: number[] = [];
  const sync = lifelogPeopleSync({
    enabled: () => true,
    engine: () => undefined,
    now: () => now,
    read: async () => source,
    send: (_, __, body) => {
      revisions.push((body as { revision: number }).revision);
      return new Promise((resolve) => {
        release = () => resolve({});
      });
    },
  });
  const first = sync();
  await Promise.resolve();
  await sync();
  expect(revisions).toEqual([100]);
  release?.();
  await first;
  source = { ...source, corrections: [], inferred: [], truth: { people: [] } };
  now = 90;
  const next = sync();
  await Promise.resolve();
  expect(revisions).toEqual([100, 101]);
  expect(lifelogPeopleOf(source)).toEqual({
    complete: true,
    folds: {},
    people: [],
    version: 1,
  });
  release?.();
  await next;
});
