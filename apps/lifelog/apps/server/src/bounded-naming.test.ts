import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { NAMING } from "./config";
import {
  boundNamingInput,
  boundNamingInputs,
  buildNamingInput,
  namingBacklogClass,
  parseNamingReadings,
} from "./inferred-speakers";
import { NO_PROFILES } from "./speakers";

type Construction = Parameters<typeof boundNamingInput>[0];
const person = (index: number) => ({
  aliases: [],
  canonicalRef: `person:${String(index).padStart(4, "0")}`,
  name: `Person ${index}`,
  personId: `person-${index}`,
});
const turn = (index: number) => ({
  jobId: "job",
  speakerLabel: "speaker",
  text: `Turn ${index}.`,
  turnIndex: index,
});
const target = (index: number) => ({
  candidates: null,
  clean: true,
  id: `scope-${index}`,
  jobId: "job",
  profiles: NO_PROFILES,
  speakerLabel: "speaker",
  turnIndices: [index],
  vector: null,
});
function construction(people = 1, turns = 81): Construction {
  return {
    conversationId: "conversation",
    people: Array.from({ length: people }, (_, i) => person(i)),
    snapshotHash: "complete-semantic-snapshot",
    snapshotRevision: 1,
    targets: Array.from({ length: turns }, (_, i) => target(i)),
    turns: Array.from({ length: turns }, (_, i) => turn(i)),
  };
}

test("ordinary conversations with 81 unchecked scopes make progress through one bounded input at a time", () => {
  const source = construction();
  const first = boundNamingInput(source);
  assert(first);
  expect(first.scopes).toHaveLength(NAMING.contextMaxScopes);
  expect(first.scopes.some((s) => s.turnIndices.includes(80))).toBe(false);
  const selected = new Set(first.scopes.map((s) => s.id));
  const remaining = boundNamingInput({
    ...source,
    targets: source.targets.filter((s) => !selected.has(s.id)),
  });
  assert(remaining);
  expect(remaining.scopes.map((s) => s.turnIndices)).toEqual([[80]]);
  assert(source.snapshotHash);
  expect(first.snapshotHash).toBe(source.snapshotHash);
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(
    NAMING.contextMaxChars
  );
});

test("large candidate sets and 400-plus turns prioritize constraints, trusted identity, local rankings and exact mentions", () => {
  const source = construction(150, 500);
  source.targets = Array.from({ length: 90 }, (_, i) => target(i + 100));
  const [first] = source.targets;
  assert(first);
  first.candidates = { people: ["person-148"], unknown: false };
  first.vector = [1, 0];
  first.profiles = {
    people: [146, 145, 144, 143].map((i, ordinal) => ({
      exemplars: [[1 - ordinal / 10, ordinal / 10]],
      isOwner: false,
      personId: `person-${i}`,
    })),
    strangers: [],
  };
  const [trusted, spoken] = source.turns.slice(99, 101);
  const [mentioned] = source.people.slice(149);
  assert(spoken && trusted && mentioned);
  mentioned.aliases = ["Exact Alias"];
  spoken.text = "I met Exact Alias.";
  Object.assign(trusted, { personId: "person-147", source: "owner" });
  const built = boundNamingInput(source);
  assert(built);
  expect(built.turns.length).toBeLessThanOrEqual(NAMING.contextMaxTurns);
  expect(built.people).toHaveLength(NAMING.contextMaxPeople);
  for (const id of [148, 147, 146, 145, 144, 149]) {
    expect(built.people.some((p) => p.personId === `person-${id}`)).toBe(true);
  }
  expect(built.scopes.find((s) => s.id === first.id)?.rankings).toHaveLength(
    NAMING.contextRankings
  );
  expect(built.turns.find((t) => t.turnIndex === 100)?.text).toBe(
    "I met Exact Alias."
  );
  expect(built.participants).toBeNull();
  expect(JSON.stringify(built).length).toBeLessThanOrEqual(
    NAMING.contextMaxChars
  );
  expect(JSON.stringify(built)).not.toContain('"vector"');
  expect(JSON.stringify(built)).not.toContain('"exemplars"');
  const reordered = boundNamingInput({
    ...source,
    people: [...source.people].reverse(),
    snapshotRevision: 2,
    targets: [...source.targets].reverse(),
  });
  expect(reordered?.inputHash).toBe(built.inputHash);
});

test("full payload bounds shrink non-target context before the candidate tail and keep target text whole", () => {
  const source = construction(120, 5);
  source.targets = [target(2)];
  const [spoken] = source.turns.slice(2);
  assert(spoken);
  spoken.text = "This exact target remains whole.";
  source.turns = source.turns.map((t) =>
    t.turnIndex === 2 ? t : { ...t, text: "Long nearby words. ".repeat(2000) }
  );
  source.people = source.people.map((p) => ({
    ...p,
    aliases: ["Long candidate alias. ".repeat(100)],
  }));
  const built = boundNamingInput(source);
  assert(built);
  expect(built.turns.map((t) => t.text)).toEqual([spoken.text]);
  expect(built.people.length).toBeGreaterThan(0);
  expect(built.people.length).toBeLessThan(NAMING.contextMaxPeople);
  expect(JSON.stringify(built).length).toBeLessThanOrEqual(
    NAMING.contextMaxChars
  );
});

test("a single oversized target is ineligible without truncating its quote", () => {
  const source = construction(1, 1);
  source.turns = [{ ...turn(0), text: "x".repeat(NAMING.contextMaxChars + 1) }];
  expect(boundNamingInput(source)).toBeNull();
});

test("participant premise evidence is remapped only when every quoted turn and person remains", () => {
  const source = construction(2, 500);
  source.targets = [target(450)];
  source.participants = {
    evidence: [{ quote: "Turn 449.", turn: 449 }],
    personIds: ["person-0", "person-1"],
    source: "independent",
  };
  const built = boundNamingInput(source);
  assert(built?.participants);
  const [evidence] = built.participants.evidence;
  assert(evidence);
  expect(built.turns[evidence.turn]?.turnIndex).toBe(449);
  expect(built.turns[evidence.turn]?.text).toBe(evidence.quote);
  expect(evidence.turn).not.toBe(449);
  const dropped = boundNamingInput({
    ...source,
    participants: {
      ...source.participants,
      evidence: [{ quote: "Turn 0.", turn: 0 }],
    },
  });
  expect(dropped?.participants).toBeNull();
  expect(
    parseNamingReadings(
      JSON.stringify({
        readings: [
          {
            basis: "context",
            confidence: 1,
            evidence: [{ quote: evidence.quote, turn: evidence.turn }],
            personId: "person-1",
            scopeId: "scope-450",
          },
        ],
      }),
      built
    )
  ).toHaveLength(1);
});

test("mention selection uses whole names and aliases rather than partial-name presence", () => {
  const source = construction(101, 1);
  source.people.push(
    { aliases: [], canonicalRef: "z-ann", name: "Ann", personId: "ann" },
    {
      aliases: ["Anne"],
      canonicalRef: "z-anne",
      name: "Long Name",
      personId: "anne",
    }
  );
  source.turns = [{ ...turn(0), text: "Anne is mentioned in a story." }];
  const built = boundNamingInput(source);
  assert(built);
  expect(built.people.some((p) => p.personId === "anne")).toBe(true);
  expect(built.people.some((p) => p.personId === "ann")).toBe(false);
  expect(built.participants).toBeNull();
  expect(built.turns[0]?.personId).toBeNull();
});

test("the strict constructor rejects oversized callers instead of silently truncating them", () => {
  expect(() => buildNamingInput(construction(101, 1))).toThrow("bounds");
  expect(() => buildNamingInput(construction(1, 81))).toThrow("bounds");
});

test("all disjoint windows are selectable so a capped first window cannot hide scope 81", () => {
  const source = construction();
  const windows = boundNamingInputs(source);
  expect(windows.map((window) => window.scopes.length)).toEqual([
    NAMING.contextMaxScopes,
    1,
  ]);
  const ids = windows.flatMap((window) =>
    window.scopes.map((scope) => scope.id)
  );
  expect(new Set(ids).size).toBe(source.targets.length);
  expect(ids).toContain("scope-80");
  expect(
    windows.every(
      (window) => JSON.stringify(window).length <= NAMING.contextMaxChars
    )
  ).toBe(true);
  expect(
    boundNamingInputs({
      ...source,
      targets: [...source.targets].reverse(),
    }).map((window) => window.inputHash)
  ).toEqual(windows.map((window) => window.inputHash));
});

test("an oversized first target is skipped while other scopes keep their exact text and quotes", () => {
  const source = construction(1, 3);
  source.turns = source.turns.map((t) =>
    t.turnIndex === 0
      ? { ...t, text: "x".repeat(NAMING.contextMaxChars + 1) }
      : t
  );
  const windows = boundNamingInputs(source);
  expect(
    windows.flatMap((window) => window.scopes.map((scope) => scope.id))
  ).toEqual(["scope-1", "scope-2"]);
  expect(windows.flatMap((window) => window.turns.map((t) => t.text))).toEqual([
    "Turn 1.",
    "Turn 2.",
  ]);
});

test("backlog classification keeps pair, trusted voice and context ordering in the existing queue", () => {
  const [context] = boundNamingInputs(construction(2, 1));
  assert(context);
  expect(namingBacklogClass(context)).toBe(NAMING.backlogContext);
  expect(
    namingBacklogClass({
      ...context,
      turns: context.turns.map((t) => ({ ...t, personId: "person-0" })),
    })
  ).toBe(NAMING.backlogVoice);
  expect(
    namingBacklogClass({
      ...context,
      scopes: context.scopes.map((scope) => ({
        ...scope,
        rankings: [{ margin: 0.2, personId: "person-0", score: 0.8 }],
      })),
    })
  ).toBe(NAMING.backlogVoice);
  expect(
    namingBacklogClass({
      ...context,
      participants: {
        evidence: [{ quote: "Turn 0.", turn: 0 }],
        personIds: ["person-0", "person-1"],
        source: "independent",
      },
    })
  ).toBe(NAMING.backlogOwnerPair);
});
